#include "videopreviewwidget.h"
#include "isodatetimeedit.h"

#include <QComboBox>
#include <QFont>
#include <QHBoxLayout>
#include <QLabel>
#include <QPainter>
#include <QPushButton>
#include <QSignalBlocker>
#include <QSlider>
#include <QStyle>
#include <QTimer>
#include <QVBoxLayout>

#include <algorithm>

VideoCanvas::VideoCanvas(QWidget* parent) : QWidget(parent)
{
  setMinimumSize(400, 225);
  setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
  setPlaceholder(tr("Open an MCAP file to preview Head Color"));
}

void VideoCanvas::setImage(const QImage& image)
{
  image_ = image;
  update();
}

void VideoCanvas::setPlaceholder(const QString& text)
{
  placeholder_ = text;
  image_ = {};
  update();
}

void VideoCanvas::paintEvent(QPaintEvent*)
{
  QPainter painter(this);
  painter.fillRect(rect(), QColor(13, 17, 23));

  if (image_.isNull())
  {
    painter.setPen(QColor(190, 198, 210));
    const QRect text_rect = rect().adjusted(32, 24, -32, -24);
    painter.drawText(text_rect, Qt::AlignCenter | Qt::TextWordWrap,
                     placeholder_);
    return;
  }

  const QSize scaled_size =
      image_.size().scaled(size(), Qt::KeepAspectRatio);
  const QRect target(QPoint((width() - scaled_size.width()) / 2,
                            (height() - scaled_size.height()) / 2),
                     scaled_size);
  painter.setRenderHint(QPainter::SmoothPixmapTransform);
  painter.drawImage(target, image_);
}

VideoPreviewWidget::VideoPreviewWidget(QWidget* parent) : QWidget(parent)
{
  auto* root_layout = new QVBoxLayout(this);
  root_layout->setContentsMargins(0, 0, 0, 0);
  root_layout->setSpacing(8);

  auto* header_layout = new QHBoxLayout();
  auto* title = new QLabel(tr("Video preview"), this);
  QFont title_font = title->font();
  title_font.setBold(true);
  title->setFont(title_font);

  stream_combo_ = new QComboBox(this);
  stream_combo_->setSizeAdjustPolicy(QComboBox::AdjustToMinimumContentsLengthWithIcon);
  stream_combo_->setMinimumContentsLength(24);
  stream_combo_->setEnabled(false);

  header_layout->addWidget(title);
  header_layout->addStretch();
  header_layout->addWidget(stream_combo_, 1);
  root_layout->addLayout(header_layout);

  canvas_ = new VideoCanvas(this);
  root_layout->addWidget(canvas_, 1);

  auto* transport_layout = new QHBoxLayout();
  play_button_ = new QPushButton(this);
  play_button_->setIcon(style()->standardIcon(QStyle::SP_MediaPlay));
  play_button_->setToolTip(tr("Play"));
  play_button_->setEnabled(false);
  play_button_->setFixedWidth(38);

  playhead_slider_ = new QSlider(Qt::Horizontal, this);
  playhead_slider_->setRange(0, 0);
  playhead_slider_->setEnabled(false);

  position_label_ = new QLabel(QStringLiteral("00:00.000 / 00:00.000"), this);
  position_label_->setMinimumWidth(138);
  position_label_->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
  QFont position_font = position_label_->font();
  position_font.setStyleHint(QFont::Monospace);
  position_label_->setFont(position_font);

  transport_layout->addWidget(play_button_);
  transport_layout->addWidget(playhead_slider_, 1);
  transport_layout->addWidget(position_label_);
  root_layout->addLayout(transport_layout);

  frame_details_label_ = new QLabel(tr("No video stream loaded"), this);
  frame_details_label_->setTextInteractionFlags(Qt::TextSelectableByMouse);
  frame_details_label_->setWordWrap(true);
  root_layout->addWidget(frame_details_label_);

  playback_timer_ = new QTimer(this);
  playback_timer_->setSingleShot(true);

  connect(stream_combo_, &QComboBox::currentIndexChanged, this,
          [this](int index) {
            if (index < 0)
            {
              return;
            }
            setPlaying(false);
            emit streamSelected(
                static_cast<quint16>(
                    stream_combo_->itemData(index).toUInt()),
                stream_combo_->itemText(index));
          });
  connect(playhead_slider_, &QSlider::valueChanged, this,
          [this](int frame_index) {
            updatePositionLabel();
            emit frameRequested(frame_index);
          });
  connect(play_button_, &QPushButton::clicked, this,
          [this]() { setPlaying(!playing_); });
  connect(playback_timer_, &QTimer::timeout, this, [this]() {
    if (!playing_ || frame_times_ns_.isEmpty())
    {
      return;
    }

    const int current = playhead_slider_->value();
    if (current >= trim_last_frame_)
    {
      setPlaying(false);
      return;
    }

    playhead_slider_->setValue(current + 1);
    scheduleNextFrame();
  });
}

void VideoPreviewWidget::reset()
{
  setPlaying(false);
  frame_times_ns_.clear();
  recording_start_ns_ = 0;
  recording_end_ns_ = 0;
  trim_first_frame_ = 0;
  trim_last_frame_ = -1;

  {
    const QSignalBlocker blocker(stream_combo_);
    stream_combo_->clear();
  }
  stream_combo_->setEnabled(false);
  playhead_slider_->setEnabled(false);
  playhead_slider_->setRange(0, 0);
  play_button_->setEnabled(false);
  canvas_->setPlaceholder(tr("Open an MCAP file to preview Head Color"));
  frame_details_label_->setText(tr("No video stream loaded"));
  updatePositionLabel();
}

void VideoPreviewWidget::setStreams(const QVector<Stream>& streams,
                                    quint16 preferred_channel_id)
{
  const QSignalBlocker blocker(stream_combo_);
  stream_combo_->clear();

  int preferred_index = -1;
  for (const auto& stream : streams)
  {
    stream_combo_->addItem(stream.topic, stream.channel_id);
    if (stream.channel_id == preferred_channel_id)
    {
      preferred_index = stream_combo_->count() - 1;
    }
  }

  stream_combo_->setEnabled(!streams.isEmpty());
  if (preferred_index >= 0)
  {
    stream_combo_->setCurrentIndex(preferred_index);
  }
  else if (!streams.isEmpty())
  {
    stream_combo_->setCurrentIndex(0);
  }

  if (streams.isEmpty())
  {
    canvas_->setPlaceholder(tr("No supported color camera stream found"));
    frame_details_label_->setText(
        tr("Expected sensor_msgs/msg/CompressedImage"));
  }
}

void VideoPreviewWidget::setIndexing(const QString& topic)
{
  setPlaying(false);
  frame_times_ns_.clear();
  playhead_slider_->setEnabled(false);
  play_button_->setEnabled(false);
  canvas_->setPlaceholder(tr("Indexing %1…").arg(topic));
  frame_details_label_->setText(tr("Reading video timestamps"));
  updatePositionLabel();
}

void VideoPreviewWidget::setFrameTimeline(
    const QVector<quint64>& frame_times_ns, quint64 recording_start_ns,
    quint64 recording_end_ns)
{
  frame_times_ns_ = frame_times_ns;
  recording_start_ns_ = recording_start_ns;
  recording_end_ns_ = recording_end_ns;
  trim_first_frame_ = 0;
  trim_last_frame_ = frame_times_ns_.size() - 1;

  const QSignalBlocker blocker(playhead_slider_);
  playhead_slider_->setRange(
      0, std::max(0, static_cast<int>(frame_times_ns_.size()) - 1));
  playhead_slider_->setValue(0);
  playhead_slider_->setEnabled(!frame_times_ns_.isEmpty());
  play_button_->setEnabled(frame_times_ns_.size() > 1);

  if (frame_times_ns_.isEmpty())
  {
    canvas_->setPlaceholder(tr("The selected stream contains no frames"));
    frame_details_label_->setText(tr("No frames found"));
  }
  else
  {
    canvas_->setPlaceholder(tr("Decoding first frame…"));
    frame_details_label_->setText(
        tr("%1 frames indexed").arg(frame_times_ns_.size()));
  }
  updatePositionLabel();
}

void VideoPreviewWidget::setTrimRange(quint64 start_ns, quint64 end_ns)
{
  if (frame_times_ns_.isEmpty())
  {
    return;
  }

  auto first = std::lower_bound(frame_times_ns_.cbegin(),
                                frame_times_ns_.cend(), start_ns);
  auto after_last = std::lower_bound(frame_times_ns_.cbegin(),
                                     frame_times_ns_.cend(), end_ns);
  trim_first_frame_ = first == frame_times_ns_.cend() ?
                          frame_times_ns_.size() - 1 :
                          static_cast<int>(first - frame_times_ns_.cbegin());
  trim_last_frame_ = after_last == frame_times_ns_.cbegin() ?
                         0 :
                         static_cast<int>(
                             after_last - frame_times_ns_.cbegin() - 1);
  if (trim_last_frame_ < trim_first_frame_)
  {
    trim_last_frame_ = trim_first_frame_;
  }
}

void VideoPreviewWidget::seekToTimestamp(quint64 timestamp_ns)
{
  if (frame_times_ns_.isEmpty())
  {
    return;
  }

  auto after = std::upper_bound(frame_times_ns_.cbegin(),
                                frame_times_ns_.cend(), timestamp_ns);
  int frame_index = 0;
  if (after != frame_times_ns_.cbegin())
  {
    frame_index =
        static_cast<int>(after - frame_times_ns_.cbegin() - 1);
  }
  if (playhead_slider_->value() == frame_index)
  {
    emit frameRequested(frame_index);
  }
  else
  {
    playhead_slider_->setValue(frame_index);
  }
}

void VideoPreviewWidget::setFrame(const QImage& image, int frame_index,
                                  const QString& format,
                                  const QString& frame_id,
                                  qint64 capture_time_ns)
{
  if (frame_index != playhead_slider_->value())
  {
    return;
  }

  canvas_->setImage(image);
  const QString capture_text =
      capture_time_ns > 0 ?
          IsoTimestamp::formatNanoseconds(
              static_cast<uint64_t>(capture_time_ns)) :
          QStringLiteral("—");
  frame_details_label_->setText(
      tr("%1 × %2 · %3 · %4 · capture %5")
          .arg(image.width())
          .arg(image.height())
          .arg(format)
          .arg(frame_id)
          .arg(capture_text));
}

void VideoPreviewWidget::setFrameError(int frame_index,
                                       const QString& message)
{
  if (frame_index != playhead_slider_->value())
  {
    return;
  }
  canvas_->setPlaceholder(tr("Unable to decode this frame"));
  frame_details_label_->setText(message);
}

void VideoPreviewWidget::setPlaying(bool playing)
{
  if (playing && (frame_times_ns_.size() < 2 || trim_last_frame_ < 0))
  {
    return;
  }

  playing_ = playing;
  play_button_->setIcon(style()->standardIcon(
      playing_ ? QStyle::SP_MediaPause : QStyle::SP_MediaPlay));
  play_button_->setToolTip(playing_ ? tr("Pause") : tr("Play"));

  if (!playing_)
  {
    playback_timer_->stop();
    return;
  }

  if (playhead_slider_->value() < trim_first_frame_ ||
      playhead_slider_->value() >= trim_last_frame_)
  {
    playhead_slider_->setValue(trim_first_frame_);
  }
  scheduleNextFrame();
}

void VideoPreviewWidget::scheduleNextFrame()
{
  if (!playing_)
  {
    return;
  }

  const int current = playhead_slider_->value();
  if (current >= trim_last_frame_ ||
      current + 1 >= frame_times_ns_.size())
  {
    setPlaying(false);
    return;
  }

  const quint64 delta_ns =
      frame_times_ns_[current + 1] - frame_times_ns_[current];
  const int interval_ms = std::clamp(
      static_cast<int>(delta_ns / 1'000'000ULL), 10, 250);
  playback_timer_->start(interval_ms);
}

void VideoPreviewWidget::updatePositionLabel()
{
  quint64 current_ns = 0;
  quint64 duration_ns = 0;
  if (!frame_times_ns_.isEmpty())
  {
    const int index = std::clamp(
        playhead_slider_->value(), 0,
        static_cast<int>(frame_times_ns_.size()) - 1);
    current_ns = frame_times_ns_[index] > recording_start_ns_ ?
                     frame_times_ns_[index] - recording_start_ns_ :
                     0;
    duration_ns = recording_end_ns_ > recording_start_ns_ ?
                      recording_end_ns_ - recording_start_ns_ :
                      0;
  }

  position_label_->setText(
      QStringLiteral("%1 / %2")
          .arg(formatDuration(current_ns), formatDuration(duration_ns)));
}

QString VideoPreviewWidget::formatDuration(quint64 nanoseconds)
{
  const quint64 total_milliseconds = nanoseconds / 1'000'000ULL;
  const quint64 minutes = total_milliseconds / 60'000ULL;
  const quint64 seconds = (total_milliseconds / 1'000ULL) % 60ULL;
  const quint64 milliseconds = total_milliseconds % 1'000ULL;
  return QStringLiteral("%1:%2.%3")
      .arg(minutes, 2, 10, QLatin1Char('0'))
      .arg(seconds, 2, 10, QLatin1Char('0'))
      .arg(milliseconds, 3, 10, QLatin1Char('0'));
}
