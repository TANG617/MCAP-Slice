export interface DecodedCompressedImage {
  captureTimeNs: bigint;
  frameId: string;
  format: string;
  mimeType: "image/jpeg" | "image/png";
  data: Uint8Array;
}

export interface DecodedJointState {
  captureTimeNs: bigint;
  frameId: string;
  names: string[];
  positions: number[];
  velocities: number[];
  efforts: number[];
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

  public readI32(): number {
    this.#align(4);
    this.#require(4);
    const result = this.#view.getInt32(this.#offset, this.#littleEndian);
    this.#offset += 4;
    return result;
  }

  public readF64(): number {
    this.#align(8);
    this.#require(8);
    const result = this.#view.getFloat64(this.#offset, this.#littleEndian);
    this.#offset += 8;
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

  public readStringSequence(fieldName: string): string[] {
    const length = this.readU32();
    this.#validateSequenceLength(length, 4, fieldName);
    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
      result.push(this.readString(`${fieldName}[${index}]`));
    }
    return result;
  }

  public readF64Sequence(fieldName: string): number[] {
    const length = this.readU32();
    this.#validateSequenceLength(length, 8, fieldName);
    const result = new Array<number>(length);
    for (let index = 0; index < length; index += 1) {
      result[index] = this.readF64();
    }
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

  #validateSequenceLength(length: number, minimumBytes: number, fieldName: string): void {
    if (length > 1_000_000 || length * minimumBytes > this.#data.byteLength) {
      throw new Error(`${fieldName} has an invalid CDR sequence length.`);
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
  const seconds = reader.readI32();
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

export function decodeRos2JointState(data: Uint8Array): DecodedJointState {
  const reader = new CdrReader(data);
  const seconds = reader.readI32();
  const nanoseconds = reader.readU32();
  const frameId = reader.readString("header.frame_id");
  const names = reader.readStringSequence("name");
  const positions = reader.readF64Sequence("position");
  const velocities = reader.readF64Sequence("velocity");
  const efforts = reader.readF64Sequence("effort");

  if (nanoseconds >= 1_000_000_000) {
    throw new Error("header.stamp.nanosec is outside [0, 1e9).");
  }
  if (names.length !== positions.length) {
    throw new Error(`JointState name and position lengths differ (${names.length} vs ${positions.length}).`);
  }
  for (const [fieldName, values] of [["velocity", velocities], ["effort", efforts]] as const) {
    if (values.length !== 0 && values.length !== names.length) {
      throw new Error(`JointState ${fieldName} length must be empty or match name length.`);
    }
  }
  if (positions.some((value) => !Number.isFinite(value))) {
    throw new Error("JointState position contains a non-finite value.");
  }

  return {
    captureTimeNs: BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds),
    frameId,
    names,
    positions,
    velocities,
    efforts
  };
}
