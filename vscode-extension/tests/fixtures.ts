import { open, writeFile } from "node:fs/promises";

import { McapRecordBuilder, McapWriter } from "@mcap/core";
import { FileHandleWritable } from "@mcap/nodejs";

export const BASE_TIME_NS = 1_700_000_000_000_000_000n;

const ONE_PIXEL_PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
);

const ONE_PIXEL_JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
]);

function appendU32(bytes: number[], value: number, littleEndian: boolean): void {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, value >>> 0, littleEndian);
  bytes.push(...new Uint8Array(view.buffer));
}

function align(bytes: number[], alignment: number): void {
  const payloadOffset = bytes.length - 4;
  const padding = (alignment - (payloadOffset % alignment)) % alignment;
  for (let index = 0; index < padding; index += 1) bytes.push(0);
}

function appendString(bytes: number[], value: string, littleEndian: boolean): void {
  align(bytes, 4);
  const encoded = new TextEncoder().encode(value);
  appendU32(bytes, encoded.byteLength + 1, littleEndian);
  bytes.push(...encoded, 0);
}

export function compressedImageCdr(littleEndian = true, image = ONE_PIXEL_PNG): Uint8Array {
  const bytes = [0, littleEndian ? 1 : 0, 0, 0];
  align(bytes, 4);
  appendU32(bytes, 1_700_000_000, littleEndian);
  appendU32(bytes, 123_000_000, littleEndian);
  appendString(bytes, "camera", littleEndian);
  appendString(bytes, "png", littleEndian);
  align(bytes, 4);
  appendU32(bytes, image.byteLength, littleEndian);
  bytes.push(...image);
  return Uint8Array.from(bytes);
}

export async function writeIndexedFixture(filePath: string, messageCopies = 1): Promise<void> {
  const handle = await open(filePath, "wx");
  try {
    const writer = new McapWriter({
      writable: new FileHandleWritable(handle),
      useChunks: true,
      useStatistics: true,
      useSummaryOffsets: true,
      useMessageIndex: true,
      useChunkIndex: true,
      useAttachmentIndex: true,
      useMetadataIndex: true,
      repeatSchemas: true,
      repeatChannels: true,
      chunkSize: 64 * 1024
    });
    await writer.start({ profile: "ros2", library: "mcap-slice-tests" });
    const jsonSchemaId = await writer.registerSchema({
      name: "example.Message",
      encoding: "jsonschema",
      data: new TextEncoder().encode('{"type":"object","properties":{"value":{"type":"number"}}}')
    });
    const imageSchemaId = await writer.registerSchema({
      name: "sensor_msgs/msg/CompressedImage",
      encoding: "ros2msg",
      data: new TextEncoder().encode("std_msgs/Header header\nstring format\nuint8[] data\n")
    });
    const duplicateA = await writer.registerChannel({ schemaId: jsonSchemaId, topic: "/duplicate", messageEncoding: "json", metadata: new Map([["source", "a"]]) });
    const duplicateB = await writer.registerChannel({ schemaId: jsonSchemaId, topic: "/duplicate", messageEncoding: "json", metadata: new Map([["source", "b"]]) });
    const other = await writer.registerChannel({ schemaId: jsonSchemaId, topic: "/other", messageEncoding: "json", metadata: new Map() });
    const video = await writer.registerChannel({ schemaId: imageSchemaId, topic: "/camera/color/compressed", messageEncoding: "cdr", metadata: new Map() });
    let sequence = 0;
    for (let copy = 0; copy < messageCopies; copy += 1) {
      const offset = BigInt(copy) * 4_000_000n;
      for (const [channelId, delta, data] of [
        [duplicateA, 0n, new TextEncoder().encode('{"value":1}')],
        [duplicateB, 1_000_000n, new TextEncoder().encode('{"value":2}')],
        [other, 2_000_000n, new TextEncoder().encode('{"value":3}')],
        [video, 3_000_000n, compressedImageCdr()]
      ] as const) {
        const timestamp = BASE_TIME_NS + offset + delta;
        await writer.addMessage({ channelId, sequence: sequence++, logTime: timestamp, publishTime: timestamp, data });
      }
      const jpegTimestamp = BASE_TIME_NS + offset + 3_500_000n;
      await writer.addMessage({
        channelId: video,
        sequence: sequence++,
        logTime: jpegTimestamp,
        publishTime: jpegTimestamp,
        data: compressedImageCdr(true, ONE_PIXEL_JPEG)
      });
    }
    await writer.addMetadata({ name: "source.metadata", metadata: new Map([["key", "value"]]) });
    await writer.addAttachment({
      name: "notes.txt",
      mediaType: "text/plain",
      logTime: BASE_TIME_NS,
      createTime: BASE_TIME_NS,
      data: new TextEncoder().encode("not copied")
    });
    await writer.end();
  } finally {
    await handle.close();
  }
}

export async function writeUnindexedFixture(filePath: string): Promise<void> {
  const builder = new McapRecordBuilder();
  builder.writeMagic();
  builder.writeHeader({ profile: "test", library: "mcap-slice-tests" });
  builder.writeDataEnd({ dataSectionCrc: 0 });
  builder.writeFooter({ summaryStart: 0n, summaryOffsetStart: 0n, summaryCrc: 0 });
  builder.writeMagic();
  const handle = await open(filePath, "wx");
  try {
    await handle.write(builder.buffer);
  } finally {
    await handle.close();
  }
}

export async function writeCorruptedFixture(filePath: string): Promise<void> {
  await writeFile(filePath, Uint8Array.from([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a, 0x01]));
}
