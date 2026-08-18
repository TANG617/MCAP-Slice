import { describe, expect, it } from "vitest";

import { buildProvenance } from "../src/shared/provenance";

describe("provenance metadata", () => {
  it("uses a basename, exact source nanoseconds, and sorted unique topics", () => {
    const metadata = buildProvenance({
      extensionVersion: "0.1.0",
      sourcePath: "/private/recordings/demo.mcap",
      sourceSizeBytes: 42n,
      sourceStartNs: 1_785_355_614_000_000_123n,
      sourceEndNs: 1_785_355_615_000_000_456n,
      sliceStartNs: 1_785_355_614_000_000_000n,
      sliceEndNs: 1_785_355_615_000_000_000n,
      selectedTopics: ["/z", "/a", "/z"],
      createdAtNs: 1_785_355_620_000_000_000n
    });
    expect(metadata.name).toBe("mcap_slice.provenance.v1");
    expect(metadata.metadata.get("source.file_name")).toBe("demo.mcap");
    expect(metadata.metadata.get("source.message_start_time_ns")).toBe("1785355614000000123");
    expect(metadata.metadata.get("slice.selected_topics_json")).toBe('["/a","/z"]');
    expect(metadata.metadata.get("source.file_name")).not.toContain("recordings");
  });
});
