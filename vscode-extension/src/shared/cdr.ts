export interface DecodedCompressedImage {
  captureTimeNs: bigint;
  frameId: string;
  format: string;
  mimeType: "image/jpeg" | "image/png";
  data: Uint8Array;
}

class CdrReader {
  readonly #data: Uint8Array;
  readonly #view: DataView;
  readonly #littleEndian: boolean;
  #offset = 4;

  public constructor(data: Uint8Array) {
    if (data.byteLength < 4) {
      throw new Error("Message is too short to contain a CDR header.");
    }
    this.#data = data;
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const representation = (data[0]! << 8) | data[1]!;
    if (representation > 1) {
      throw new Error(`Unsupported CDR representation identifier: ${representation}`);
    }
    this.#littleEndian = (representation & 1) !== 0;
  }

  public readU32(): number {
    this.#align(4);
    this.#require(4);
    const result = this.#view.getUint32(this.#offset, this.#littleEndian);
    this.#offset += 4;
    return result;
  }

  public readString(fieldName: string): string {
    const length = this.readU32();
    if (length === 0) {
      throw new Error(`${fieldName} has an invalid zero-length CDR string.`);
    }
    this.#require(length);
    if (this.#data[this.#offset + length - 1] !== 0) {
      throw new Error(`${fieldName} is not null terminated.`);
    }
    const result = new TextDecoder("utf-8", { fatal: true }).decode(
      this.#data.subarray(this.#offset, this.#offset + length - 1)
    );
    this.#offset += length;
    return result;
  }

  public readByteSequence(fieldName: string): Uint8Array {
    const length = this.readU32();
    try {
      this.#require(length);
    } catch {
      throw new Error(`${fieldName} exceeds the CDR message bounds.`);
    }
    const result = this.#data.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  #align(alignment: number): void {
    const payloadOffset = this.#offset - 4;
    const padding = (alignment - (payloadOffset % alignment)) % alignment;
    this.#require(padding);
    this.#offset += padding;
  }

  #require(count: number): void {
    if (count < 0 || this.#offset > this.#data.byteLength || count > this.#data.byteLength - this.#offset) {
      throw new Error("Unexpected end of CDR message.");
    }
  }
}

function detectMimeType(data: Uint8Array): "image/jpeg" | "image/png" {
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.byteLength >= png.length && png.every((value, index) => data[index] === value)) {
    return "image/png";
  }
  throw new Error("The compressed image is not a supported JPEG or PNG payload.");
}

export function decodeRos2CompressedImage(data: Uint8Array): DecodedCompressedImage {
  const reader = new CdrReader(data);
  const secondsUnsigned = reader.readU32();
  const seconds = secondsUnsigned > 0x7fffffff ? secondsUnsigned - 0x1_0000_0000 : secondsUnsigned;
  const nanoseconds = reader.readU32();
  const frameId = reader.readString("header.frame_id");
  const format = reader.readString("format");
  const encodedImage = reader.readByteSequence("data");
  if (nanoseconds >= 1_000_000_000) {
    throw new Error("header.stamp.nanosec is outside [0, 1e9).");
  }
  if (encodedImage.byteLength === 0) {
    throw new Error("CompressedImage contains no image data.");
  }
  return {
    captureTimeNs: BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds),
    frameId,
    format,
    mimeType: detectMimeType(encodedImage),
    data: encodedImage
  };
}
