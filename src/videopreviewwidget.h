#pragma once

#include <QImage>
#include <QVector>
#include <QWidget>

class QComboBox;
class QLabel;
class QPushButton;
class QSlider;
class QTimer;

class VideoCanvas : public QWidget
{
  Q_OBJECT

public:
  explicit VideoCanvas(QWidget* parent = nullptr);

  void setImage(const QImage& image);
  void setPlaceholder(const QString& text);

protected:
  void paintEvent(QPaintEvent* event) override;

private:
  QImage image_;
  QString placeholder_;
};

class VideoPreviewWidget : public QWidget
{
  Q_OBJECT

public:
  struct Stream
  {
    quint16 channel_id = 0;
    QString topic;
  };

  explicit VideoPreviewWidget(QWidget* parent = nullptr);

  void reset();
  void setStreams(const QVector<Stream>& streams,
                  quint16 preferred_channel_id);
  void setIndexing(const QString& topic);
  void setFrameTimeline(const QVector<quint64>& frame_times_ns,
                        quint64 recording_start_ns,
                        quint64 recording_end_ns);
  void setTrimRange(quint64 start_ns, quint64 end_ns);
  void seekToTimestamp(quint64 timestamp_ns);
  void setFrame(const QImage& image, int frame_index, const QString& format,
                const QString& frame_id, qint64 capture_time_ns);
  void setFrameError(int frame_index, const QString& message);

signals:
  void streamSelected(quint16 channel_id, const QString& topic);
  void frameRequested(int frame_index);

private:
  void setPlaying(bool playing);
  void scheduleNextFrame();
  void updatePositionLabel();
  static QString formatDuration(quint64 nanoseconds);

  QComboBox* stream_combo_ = nullptr;
  VideoCanvas* canvas_ = nullptr;
  QPushButton* play_button_ = nullptr;
  QSlider* playhead_slider_ = nullptr;
  QLabel* position_label_ = nullptr;
  QLabel* frame_details_label_ = nullptr;
  QTimer* playback_timer_ = nullptr;

  QVector<quint64> frame_times_ns_;
  quint64 recording_start_ns_ = 0;
  quint64 recording_end_ns_ = 0;
  int trim_first_frame_ = 0;
  int trim_last_frame_ = -1;
  bool playing_ = false;
};
