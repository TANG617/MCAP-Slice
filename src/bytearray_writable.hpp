#pragma once

#include <mcap/writer.hpp>

#include <QByteArray>
#include <QIODevice>
#include <QString>

class ByteArrayInterface : public mcap::IWritable
{
public:
  ~ByteArrayInterface() override = default;

  void end() override
  {
    bytes_.end();
  };

  uint64_t size() const override
  {
    return bytes_.size();
  };

  const QByteArray& byteArray() const
  {
    return bytes_;
  }

protected:
  void handleWrite(const std::byte* data, uint64_t size) override
  {
    bytes_.append(reinterpret_cast<const char*>(data), size);
  }

  QByteArray bytes_;
};

class QIODeviceInterface : public mcap::IWritable
{
public:
  explicit QIODeviceInterface(QIODevice& device) : device_(device)
  {}

  ~QIODeviceInterface() override = default;

  void end() override
  {}

  uint64_t size() const override
  {
    return size_;
  }

  bool ok() const
  {
    return error_message_.isEmpty();
  }
  const QString& errorMessage() const
  {
    return error_message_;
  }

protected:
  void handleWrite(const std::byte* data, uint64_t size) override
  {
    if (!ok())
    {
      return;
    }

    const auto written =
        device_.write(reinterpret_cast<const char*>(data), static_cast<qint64>(size));

    if (written != static_cast<qint64>(size))
    {
      error_message_ = device_.errorString();
      if (error_message_.isEmpty())
      {
        error_message_ = QStringLiteral("Incomplete write");
      }
      return;
    }
    size_ += size;
  }

private:
  QIODevice& device_;
  uint64_t size_ = 0;
  QString error_message_;
};
