import { describe, expect, it } from "vitest";

import { decodeRos2CompressedImage, decodeRos2JointState } from "../src/shared/cdr";
import { compressedImageCdr, jointStateCdr } from "./fixtures";

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

describe("ROS 2 JointState CDR decoder", () => {
  it.each([true, false])("decodes %s-endian CDR", (littleEndian) => {
    const decoded = decodeRos2JointState(
      jointStateCdr(littleEndian, ["joint_a", "joint_b"], [Math.PI / 2, 0.125], [1, 2], [])
    );
    expect(decoded.captureTimeNs).toBe(1_700_000_000_456_000_000n);
    expect(decoded.frameId).toBe("base_link");
    expect(decoded.names).toEqual(["joint_a", "joint_b"]);
    expect(decoded.positions).toEqual([Math.PI / 2, 0.125]);
    expect(decoded.velocities).toEqual([1, 2]);
    expect(decoded.efforts).toEqual([]);
  });

  it("rejects inconsistent arrays and non-finite positions", () => {
    expect(() => decodeRos2JointState(jointStateCdr(true, ["a"], []))).toThrow("lengths differ");
    expect(() => decodeRos2JointState(jointStateCdr(true, ["a"], [0], [1, 2]))).toThrow("velocity length");
    expect(() => decodeRos2JointState(jointStateCdr(true, ["a"], [Number.NaN]))).toThrow("non-finite");
  });

  it("rejects truncated JointState payloads", () => {
    const encoded = jointStateCdr();
    expect(() => decodeRos2JointState(encoded.slice(0, encoded.length - 1))).toThrow("Unexpected end");
  });
});
