#include "isodatetimeedit.h"

#include <QApplication>
#include <QDate>
#include <QDateTime>
#include <QTime>

#include <iostream>

namespace
{
class TestableIsoDateTimeEdit : public IsoDateTimeEdit
{
public:
  using IsoDateTimeEdit::dateTimeFromText;
  using IsoDateTimeEdit::fixup;
  using IsoDateTimeEdit::textFromDateTime;
};

bool expect(bool condition, const char* message)
{
  if (!condition)
  {
    std::cerr << message << '\n';
  }
  return condition;
}
}

int main(int argc, char** argv)
{
  QApplication application(argc, argv);
  const qint64 expected =
      QDateTime(QDate(2026, 7, 29), QTime(20, 6, 56, 682),
                QTimeZone::UTC)
          .toMSecsSinceEpoch();

  bool passed = true;
  passed &= expect(
      IsoTimestamp::formatMilliseconds(expected) ==
          QStringLiteral("2026-07-30T04:06:56.682+08:00"),
      "Shanghai formatting was incorrect");
  passed &= expect(
      IsoTimestamp::formatNanoseconds(
          static_cast<uint64_t>(expected) * 1'000'000ULL +
          999'999ULL) ==
          QStringLiteral("2026-07-30T04:06:56.682+08:00"),
      "nanoseconds were not truncated to milliseconds");

  const auto local = IsoTimestamp::parseMilliseconds(
      QStringLiteral("2026-07-30T04:06:56.682+08:00"));
  const auto utc = IsoTimestamp::parseMilliseconds(
      QStringLiteral("2026-07-29T20:06:56.682Z"));
  const auto other_offset = IsoTimestamp::parseMilliseconds(
      QStringLiteral("2026-07-30T05:06:56.682+09:00"));
  const auto nanoseconds = IsoTimestamp::parseMilliseconds(
      QStringLiteral("2026-07-30T04:06:56.682999999+08:00"));
  const auto one_digit = IsoTimestamp::parseMilliseconds(
      QStringLiteral("2026-07-30T04:06:56.6+08:00"));

  passed &= expect(local.has_value() && local.value() == expected,
                   "the +08:00 timestamp did not parse");
  passed &= expect(utc.has_value() && utc.value() == expected,
                   "the Z timestamp did not preserve the instant");
  passed &= expect(other_offset.has_value() &&
                       other_offset.value() == expected,
                   "the non-Shanghai offset did not preserve the instant");
  passed &= expect(nanoseconds.has_value() &&
                       nanoseconds.value() == expected,
                   "fractional nanoseconds were not truncated");
  passed &= expect(one_digit.has_value() &&
                       one_digit.value() == expected - 82,
                   "a one-digit fraction did not parse as tenths");
  passed &= expect(
      !IsoTimestamp::parseMilliseconds(
           QStringLiteral("2026-07-30T04:06:56.682"))
           .has_value(),
      "a timestamp without a timezone was accepted");
  passed &= expect(
      !IsoTimestamp::parseMilliseconds(
           QStringLiteral("2026-02-30T04:06:56.682+08:00"))
           .has_value(),
      "an invalid calendar date was accepted");
  passed &= expect(
      !IsoTimestamp::parseMilliseconds(
           QStringLiteral("not-a-timestamp"))
           .has_value(),
      "invalid text was accepted");

  TestableIsoDateTimeEdit edit;
  edit.setDateTime(QDateTime::fromMSecsSinceEpoch(
      expected, IsoTimestamp::displayTimeZone()));
  passed &= expect(
      edit.textFromDateTime(edit.dateTime()) ==
          QStringLiteral("2026-07-30T04:06:56.682+08:00"),
      "the native editor did not display the canonical format");
  passed &= expect(
      edit.dateTimeFromText(
              QStringLiteral("2026-07-29T20:06:56.682Z"))
              .toMSecsSinceEpoch() == expected,
      "the native editor did not accept a Z timestamp");

  QString invalid = QStringLiteral("2026-07-30 04:06:56");
  edit.fixup(invalid);
  passed &= expect(
      invalid ==
          QStringLiteral("2026-07-30T04:06:56.682+08:00"),
      "invalid input did not revert to the previous valid value");

  return passed ? 0 : 1;
}
