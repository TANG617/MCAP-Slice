#include "isodatetimeedit.h"

#include <QRegularExpression>

#include <limits>

namespace
{
const QRegularExpression& isoTimestampPattern()
{
  static const QRegularExpression pattern(
      QStringLiteral(
          R"(^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$)"));
  return pattern;
}
}

QTimeZone IsoTimestamp::displayTimeZone()
{
  const QTimeZone shanghai("Asia/Shanghai");
  return shanghai.isValid() ?
             shanghai :
             QTimeZone::fromSecondsAheadOfUtc(8 * 60 * 60);
}

QString IsoTimestamp::formatMilliseconds(qint64 milliseconds_since_epoch)
{
  return QDateTime::fromMSecsSinceEpoch(milliseconds_since_epoch,
                                        displayTimeZone())
      .toString(Qt::ISODateWithMs);
}

QString IsoTimestamp::formatNanoseconds(uint64_t nanoseconds_since_epoch)
{
  const uint64_t milliseconds = nanoseconds_since_epoch / 1'000'000ULL;
  if (milliseconds >
      static_cast<uint64_t>(std::numeric_limits<qint64>::max()))
  {
    return {};
  }
  return formatMilliseconds(static_cast<qint64>(milliseconds));
}

std::optional<qint64> IsoTimestamp::parseMilliseconds(const QString& text)
{
  const auto match = isoTimestampPattern().match(text.trimmed());
  if (!match.hasMatch())
  {
    return std::nullopt;
  }

  QString fraction = match.captured(2);
  if (fraction.isEmpty())
  {
    fraction = QStringLiteral("000");
  }
  else
  {
    fraction = fraction.left(3);
    fraction = fraction.leftJustified(3, QLatin1Char('0'));
  }

  const QString normalized =
      match.captured(1) + QLatin1Char('.') + fraction + match.captured(3);
  const QDateTime parsed =
      QDateTime::fromString(normalized, Qt::ISODateWithMs);
  if (!parsed.isValid())
  {
    return std::nullopt;
  }
  return parsed.toMSecsSinceEpoch();
}

IsoDateTimeEdit::IsoDateTimeEdit(QWidget* parent) : QDateTimeEdit(parent)
{
  setDisplayFormat(QStringLiteral("yyyy-MM-dd'T'HH:mm:ss.zzzttt"));
  setButtonSymbols(QAbstractSpinBox::NoButtons);
#if QT_VERSION >= QT_VERSION_CHECK(6, 10, 0)
  setTimeZone(IsoTimestamp::displayTimeZone());
#else
  setTimeSpec(Qt::TimeSpec::OffsetFromUTC);
#endif
}

QValidator::State IsoDateTimeEdit::validate(QString& input,
                                            int& position) const
{
  const auto milliseconds = IsoTimestamp::parseMilliseconds(input);
  if (milliseconds.has_value())
  {
    const QDateTime parsed = QDateTime::fromMSecsSinceEpoch(
        milliseconds.value(), IsoTimestamp::displayTimeZone());
    return parsed < minimumDateTime() || parsed > maximumDateTime() ?
               QValidator::Invalid :
               QValidator::Acceptable;
  }
  return QDateTimeEdit::validate(input, position);
}

void IsoDateTimeEdit::fixup(QString& input) const
{
  const auto milliseconds = IsoTimestamp::parseMilliseconds(input);
  if (milliseconds.has_value())
  {
    input = IsoTimestamp::formatMilliseconds(milliseconds.value());
    return;
  }
  input = textFromDateTime(dateTime());
}

QDateTime IsoDateTimeEdit::dateTimeFromText(const QString& text) const
{
  const auto milliseconds = IsoTimestamp::parseMilliseconds(text);
  return milliseconds.has_value() ?
             QDateTime::fromMSecsSinceEpoch(
                 milliseconds.value(), IsoTimestamp::displayTimeZone()) :
             dateTime();
}

QString IsoDateTimeEdit::textFromDateTime(
    const QDateTime& date_time) const
{
  return IsoTimestamp::formatMilliseconds(
      date_time.toMSecsSinceEpoch());
}
