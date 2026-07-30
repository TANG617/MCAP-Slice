#include "timerangeslider.h"

#include <QKeyEvent>
#include <QMouseEvent>
#include <QPainter>
#include <QStyle>

#include <algorithm>
#include <cmath>

namespace
{
constexpr qreal kHorizontalPadding = 14.0;
constexpr qreal kTrackHeight = 6.0;
constexpr qreal kHandleWidth = 12.0;
constexpr qreal kHandleHeight = 28.0;
constexpr qreal kHitRadius = 14.0;
}   // namespace

TimeRangeSlider::TimeRangeSlider(QWidget* parent) : QWidget(parent)
{
  setAccessibleName(tr("Export time range"));
  setFocusPolicy(Qt::StrongFocus);
  setMouseTracking(true);
  setMinimumHeight(42);
  setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Fixed);
  setToolTip(tr("Drag either handle to choose the exported time range"));
}

qint64 TimeRangeSlider::minimum() const
{
  return minimum_;
}

qint64 TimeRangeSlider::maximum() const
{
  return maximum_;
}

qint64 TimeRangeSlider::lowerValue() const
{
  return lower_value_;
}

qint64 TimeRangeSlider::upperValue() const
{
  return upper_value_;
}

void TimeRangeSlider::setRange(qint64 minimum, qint64 maximum)
{
  if (maximum < minimum)
  {
    std::swap(minimum, maximum);
  }

  minimum_ = minimum;
  maximum_ = maximum;
  setValues(lower_value_, upper_value_);
  update();
}

void TimeRangeSlider::setValues(qint64 lower, qint64 upper)
{
  lower = std::clamp(lower, minimum_, maximum_);
  upper = std::clamp(upper, minimum_, maximum_);
  if (upper < lower)
  {
    std::swap(lower, upper);
  }

  const bool lower_changed = lower != lower_value_;
  const bool upper_changed = upper != upper_value_;
  lower_value_ = lower;
  upper_value_ = upper;

  if (lower_changed)
  {
    emit lowerValueChanged(lower_value_);
  }
  if (upper_changed)
  {
    emit upperValueChanged(upper_value_);
  }
  if (lower_changed || upper_changed)
  {
    emit valuesChanged(lower_value_, upper_value_);
    update();
  }
}

void TimeRangeSlider::setLowerValue(qint64 value)
{
  value = std::clamp(value, minimum_, upper_value_);
  if (value == lower_value_)
  {
    return;
  }

  lower_value_ = value;
  emit lowerValueChanged(lower_value_);
  emit valuesChanged(lower_value_, upper_value_);
  update();
}

void TimeRangeSlider::setUpperValue(qint64 value)
{
  value = std::clamp(value, lower_value_, maximum_);
  if (value == upper_value_)
  {
    return;
  }

  upper_value_ = value;
  emit upperValueChanged(upper_value_);
  emit valuesChanged(lower_value_, upper_value_);
  update();
}

qreal TimeRangeSlider::positionForValue(qint64 value) const
{
  const qreal available_width = std::max<qreal>(1.0, width() - 2.0 * kHorizontalPadding);
  if (maximum_ == minimum_)
  {
    return kHorizontalPadding;
  }

  const long double ratio = static_cast<long double>(value - minimum_) /
                            static_cast<long double>(maximum_ - minimum_);
  return kHorizontalPadding + available_width * static_cast<qreal>(ratio);
}

qint64 TimeRangeSlider::valueForPosition(qreal position) const
{
  const qreal available_width = std::max<qreal>(1.0, width() - 2.0 * kHorizontalPadding);
  const qreal ratio =
      std::clamp((position - kHorizontalPadding) / available_width, 0.0, 1.0);
  const long double value = static_cast<long double>(minimum_) +
                            static_cast<long double>(maximum_ - minimum_) * ratio;
  return static_cast<qint64>(std::llround(value));
}

void TimeRangeSlider::moveActiveHandle(qint64 value)
{
  if (active_handle_ == Handle::Lower)
  {
    setLowerValue(value);
  }
  else if (active_handle_ == Handle::Upper)
  {
    setUpperValue(value);
  }
}

void TimeRangeSlider::mousePressEvent(QMouseEvent* event)
{
  if (event->button() != Qt::LeftButton)
  {
    QWidget::mousePressEvent(event);
    return;
  }

  const qreal lower_distance =
      std::abs(event->position().x() - positionForValue(lower_value_));
  const qreal upper_distance =
      std::abs(event->position().x() - positionForValue(upper_value_));

  if (std::abs(lower_distance - upper_distance) < 0.5)
  {
    const qreal midpoint =
        (positionForValue(lower_value_) + positionForValue(upper_value_)) / 2.0;
    active_handle_ = event->position().x() < midpoint ? Handle::Lower : Handle::Upper;
  }
  else
  {
    active_handle_ = lower_distance < upper_distance ? Handle::Lower : Handle::Upper;
  }
  setFocus(Qt::MouseFocusReason);
  moveActiveHandle(valueForPosition(event->position().x()));
  setCursor(Qt::ClosedHandCursor);
  event->accept();
}

void TimeRangeSlider::mouseMoveEvent(QMouseEvent* event)
{
  if (active_handle_ != Handle::None && event->buttons().testFlag(Qt::LeftButton))
  {
    moveActiveHandle(valueForPosition(event->position().x()));
    event->accept();
    return;
  }

  const qreal lower_distance =
      std::abs(event->position().x() - positionForValue(lower_value_));
  const qreal upper_distance =
      std::abs(event->position().x() - positionForValue(upper_value_));
  setCursor(std::min(lower_distance, upper_distance) <= kHitRadius ? Qt::OpenHandCursor :
                                                                     Qt::ArrowCursor);
  QWidget::mouseMoveEvent(event);
}

void TimeRangeSlider::mouseReleaseEvent(QMouseEvent* event)
{
  if (event->button() == Qt::LeftButton)
  {
    active_handle_ = Handle::None;
    setCursor(Qt::OpenHandCursor);
    update();
    event->accept();
    return;
  }
  QWidget::mouseReleaseEvent(event);
}

void TimeRangeSlider::keyPressEvent(QKeyEvent* event)
{
  if (active_handle_ == Handle::None)
  {
    active_handle_ = event->key() == Qt::Key_Tab ? Handle::Upper : Handle::Lower;
  }

  const qint64 span = std::max<qint64>(1, maximum_ - minimum_);
  qint64 step = std::max<qint64>(1, span / 1000);
  if (event->modifiers().testFlag(Qt::ShiftModifier))
  {
    step *= 10;
  }

  qint64 current = active_handle_ == Handle::Upper ? upper_value_ : lower_value_;
  if (event->key() == Qt::Key_Left || event->key() == Qt::Key_Down)
  {
    moveActiveHandle(current - step);
  }
  else if (event->key() == Qt::Key_Right || event->key() == Qt::Key_Up)
  {
    moveActiveHandle(current + step);
  }
  else if (event->key() == Qt::Key_Home)
  {
    moveActiveHandle(minimum_);
  }
  else if (event->key() == Qt::Key_End)
  {
    moveActiveHandle(maximum_);
  }
  else if (event->key() == Qt::Key_Space)
  {
    active_handle_ = active_handle_ == Handle::Lower ? Handle::Upper : Handle::Lower;
    update();
  }
  else
  {
    QWidget::keyPressEvent(event);
    return;
  }

  event->accept();
}

void TimeRangeSlider::paintEvent(QPaintEvent*)
{
  QPainter painter(this);
  painter.setRenderHint(QPainter::Antialiasing);

  const qreal center_y = height() / 2.0;
  const qreal lower_x = positionForValue(lower_value_);
  const qreal upper_x = positionForValue(upper_value_);
  const QRectF track(kHorizontalPadding, center_y - kTrackHeight / 2.0,
                     std::max<qreal>(1.0, width() - 2.0 * kHorizontalPadding),
                     kTrackHeight);
  const QRectF selection(lower_x, center_y - kTrackHeight / 2.0,
                         std::max<qreal>(0.0, upper_x - lower_x), kTrackHeight);

  painter.setPen(Qt::NoPen);
  painter.setBrush(palette().color(QPalette::Mid));
  painter.drawRoundedRect(track, kTrackHeight / 2.0, kTrackHeight / 2.0);
  painter.setBrush(palette().color(QPalette::Highlight));
  painter.drawRoundedRect(selection, kTrackHeight / 2.0, kTrackHeight / 2.0);

  const auto draw_handle = [&](qreal x, Handle handle) {
    const QRectF handle_rect(x - kHandleWidth / 2.0, center_y - kHandleHeight / 2.0,
                             kHandleWidth, kHandleHeight);
    QPen outline(palette().color(QPalette::Highlight), 2.0);
    if (hasFocus() && active_handle_ == handle)
    {
      outline.setWidthF(3.0);
    }
    painter.setPen(outline);
    painter.setBrush(palette().color(QPalette::Window));
    painter.drawRoundedRect(handle_rect, kHandleWidth / 2.0, kHandleWidth / 2.0);
  };

  draw_handle(lower_x, Handle::Lower);
  draw_handle(upper_x, Handle::Upper);
}
