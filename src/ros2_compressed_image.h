#pragma once

#include <QByteArray>
#include <QString>

#include <cstddef>
#include <cstdint>

struct Ros2CompressedImage
{
  qint64 capture_time_ns = 0;
  QString frame_id;
  QString format;
  QByteArray encoded_image;
};

class Ros2CompressedImageDecoder
{
public:
  static bool decode(const std::byte* data, uint64_t size,
                     Ros2CompressedImage& image, QString& error_message);
};
