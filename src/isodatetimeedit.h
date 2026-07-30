#pragma once

#include <QDateTimeEdit>
#include <QTimeZone>

#include <cstdint>
#include <optional>

namespace IsoTimestamp
{
QTimeZone displayTimeZone();
QString formatMilliseconds(qint64 milliseconds_since_epoch);
QString formatNanoseconds(uint64_t nanoseconds_since_epoch);
std::optional<qint64> parseMilliseconds(const QString& text);
}

class IsoDateTimeEdit : public QDateTimeEdit
{
  Q_OBJECT

public:
  explicit IsoDateTimeEdit(QWidget* parent = nullptr);

protected:
  QValidator::State validate(QString& input, int& position) const override;
  void fixup(QString& input) const override;
  QDateTime dateTimeFromText(const QString& text) const override;
  QString textFromDateTime(const QDateTime& date_time) const override;
};
