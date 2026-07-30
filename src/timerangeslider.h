#pragma once

#include <QWidget>

class QKeyEvent;
class QMouseEvent;

class TimeRangeSlider : public QWidget
{
  Q_OBJECT
  Q_PROPERTY(
      qint64 lowerValue READ lowerValue WRITE setLowerValue NOTIFY lowerValueChanged)
  Q_PROPERTY(
      qint64 upperValue READ upperValue WRITE setUpperValue NOTIFY upperValueChanged)

public:
  explicit TimeRangeSlider(QWidget* parent = nullptr);

  qint64 minimum() const;
  qint64 maximum() const;
  qint64 lowerValue() const;
  qint64 upperValue() const;

  void setRange(qint64 minimum, qint64 maximum);
  void setValues(qint64 lower, qint64 upper);

public slots:
  void setLowerValue(qint64 value);
  void setUpperValue(qint64 value);

signals:
  void lowerValueChanged(qint64 value);
  void upperValueChanged(qint64 value);
  void valuesChanged(qint64 lower, qint64 upper);

protected:
  void keyPressEvent(QKeyEvent* event) override;
  void mouseMoveEvent(QMouseEvent* event) override;
  void mousePressEvent(QMouseEvent* event) override;
  void mouseReleaseEvent(QMouseEvent* event) override;
  void paintEvent(QPaintEvent* event) override;

private:
  enum class Handle
  {
    None,
    Lower,
    Upper,
  };

  qreal positionForValue(qint64 value) const;
  qint64 valueForPosition(qreal position) const;
  void moveActiveHandle(qint64 value);

  qint64 minimum_ = 0;
  qint64 maximum_ = 1;
  qint64 lower_value_ = 0;
  qint64 upper_value_ = 1;
  Handle active_handle_ = Handle::None;
};
