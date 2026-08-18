import { describe, expect, it } from "vitest";

import { decodeRos2CompressedImage } from "../src/shared/cdr";
import { compressedImageCdr } from "./fixtures";

describe("ROS 2 CompressedImage CDR decoder", () => {
  it.each([true, false])("decodes %s-endian CDR", (littleEndian) => {
    const decoded = decodeRos2CompressedImage(compressedImageCdr(littleEndian));
    expect(decoded.captureTimeNs).toBe(1_700_000_000_123_000_000n);
    expect(decoded.frameId).toBe("camera");
    expect(decoded.format).toBe("png");
    expect(decoded.mimeType).toBe("image/png");
    expect(decoded.data.slice(0, 4)).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("rejects truncated and unknown image payloads", () => {
    expect(() => decodeRos2CompressedImage(new Uint8Array([0, 1, 0]))).toThrow("too short");
    expect(() => decodeRos2CompressedImage(compressedImageCdr(true, Uint8Array.from([1, 2, 3])))).toThrow("not a supported JPEG or PNG");
  });

  it("recognizes JPEG payloads", () => {
    const decoded = decodeRos2CompressedImage(
      compressedImageCdr(true, Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))
    );
    expect(decoded.mimeType).toBe("image/jpeg");
  });
});
