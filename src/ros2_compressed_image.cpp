#include "ros2_compressed_image.h"

#include <cstring>
#include <limits>

namespace
{
class CdrReader
{
public:
  CdrReader(const std::byte* data, uint64_t size)
    : data_(reinterpret_cast<const uint8_t*>(data)), size_(size)
  {
    if (data_ == nullptr || size_ < 4)
    {
      error_ = QStringLiteral("Message is too short to contain a CDR header.");
      return;
    }

    const uint16_t representation =
        static_cast<uint16_t>((data_[0] << 8U) | data_[1]);
    if (representation > 1)
    {
      error_ = QStringLiteral("Unsupported CDR representation identifier: %1")
                   .arg(representation);
      return;
    }

    little_endian_ = (representation & 1U) != 0;
    offset_ = 4;
  }

  bool ok() const
  {
    return error_.isEmpty();
  }

  const QString& error() const
  {
    return error_;
  }

  uint32_t readU32()
  {
    if (!align(4) || !require(4))
    {
      return 0;
    }

    const uint8_t* bytes = data_ + offset_;
    offset_ += 4;
    if (little_endian_)
    {
      return static_cast<uint32_t>(bytes[0]) |
             (static_cast<uint32_t>(bytes[1]) << 8U) |
             (static_cast<uint32_t>(bytes[2]) << 16U) |
             (static_cast<uint32_t>(bytes[3]) << 24U);
    }
    return (static_cast<uint32_t>(bytes[0]) << 24U) |
           (static_cast<uint32_t>(bytes[1]) << 16U) |
           (static_cast<uint32_t>(bytes[2]) << 8U) |
           static_cast<uint32_t>(bytes[3]);
  }

  QString readString(const QString& field_name)
  {
    const uint32_t length = readU32();
    if (!ok())
    {
      return {};
    }
    if (length == 0)
    {
      fail(QStringLiteral("%1 has an invalid zero-length CDR string.")
               .arg(field_name));
      return {};
    }
    if (!require(length))
    {
      return {};
    }
    if (data_[offset_ + length - 1] != 0)
    {
      fail(QStringLiteral("%1 is not null terminated.").arg(field_name));
      return {};
    }

    const QString result = QString::fromUtf8(
        reinterpret_cast<const char*>(data_ + offset_),
        static_cast<qsizetype>(length - 1));
    offset_ += length;
    return result;
  }

  QByteArray readByteSequence(const QString& field_name)
  {
    const uint32_t length = readU32();
    if (!ok())
    {
      return {};
    }
    if (!require(length))
    {
      if (error_.isEmpty())
      {
        fail(QStringLiteral("%1 exceeds the CDR message bounds.")
                 .arg(field_name));
      }
      return {};
    }
    if (length > static_cast<uint32_t>(std::numeric_limits<int>::max()))
    {
      fail(QStringLiteral("%1 is too large to decode.").arg(field_name));
      return {};
    }

    QByteArray result(reinterpret_cast<const char*>(data_ + offset_),
                      static_cast<qsizetype>(length));
    offset_ += length;
    return result;
  }

private:
  bool align(uint64_t alignment)
  {
    if (!ok())
    {
      return false;
    }
    const uint64_t payload_offset = offset_ - 4;
    const uint64_t padding =
        (alignment - payload_offset % alignment) % alignment;
    if (!require(padding))
    {
      return false;
    }
    offset_ += padding;
    return true;
  }

  bool require(uint64_t byte_count)
  {
    if (!ok())
    {
      return false;
    }
    if (offset_ > size_ || byte_count > size_ - offset_)
    {
      fail(QStringLiteral("Unexpected end of CDR message."));
      return false;
    }
    return true;
  }

  void fail(const QString& message)
  {
    if (error_.isEmpty())
    {
      error_ = message;
    }
  }

  const uint8_t* data_ = nullptr;
  uint64_t size_ = 0;
  uint64_t offset_ = 0;
  bool little_endian_ = true;
  QString error_;
};
}

bool Ros2CompressedImageDecoder::decode(const std::byte* data, uint64_t size,
                                        Ros2CompressedImage& image,
                                        QString& error_message)
{
  image = {};
  error_message.clear();

  CdrReader reader(data, size);
  if (!reader.ok())
  {
    error_message = reader.error();
    return false;
  }

  const int32_t seconds = static_cast<int32_t>(reader.readU32());
  const uint32_t nanoseconds = reader.readU32();
  image.frame_id = reader.readString(QStringLiteral("header.frame_id"));
  image.format = reader.readString(QStringLiteral("format"));
  image.encoded_image = reader.readByteSequence(QStringLiteral("data"));

  if (!reader.ok())
  {
    error_message = reader.error();
    image = {};
    return false;
  }
  if (nanoseconds >= 1'000'000'000U)
  {
    error_message = QStringLiteral("header.stamp.nanosec is outside [0, 1e9).");
    image = {};
    return false;
  }
  if (image.encoded_image.isEmpty())
  {
    error_message = QStringLiteral("CompressedImage contains no image data.");
    image = {};
    return false;
  }

  image.capture_time_ns =
      static_cast<qint64>(seconds) * 1'000'000'000LL + nanoseconds;
  return true;
}
