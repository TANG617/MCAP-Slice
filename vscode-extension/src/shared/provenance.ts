import path from "node:path";

import type { Metadata } from "@mcap/core";

import { formatNanoseconds } from "./time";

export interface ProvenanceInput {
  extensionVersion: string;
  sourcePath: string;
  sourceSizeBytes: bigint;
  sourceStartNs: bigint;
  sourceEndNs: bigint;
  sliceStartNs: bigint;
  sliceEndNs: bigint;
  selectedTopics: string[];
  createdAtNs?: bigint;
}

export function buildProvenance(input: ProvenanceInput): Metadata {
  const topics = [...new Set(input.selectedTopics)].sort();
  const createdAtNs = input.createdAtNs ?? BigInt(Date.now()) * 1_000_000n;
  return {
    name: "mcap_slice.provenance.v1",
    metadata: new Map([
      ["tool.name", "MCAP Slice"],
      ["tool.version", input.extensionVersion],
      ["source.file_name", path.basename(input.sourcePath)],
      ["source.file_size_bytes", input.sourceSizeBytes.toString()],
      ["source.message_start_time", formatNanoseconds(input.sourceStartNs)],
      ["source.message_start_time_ns", input.sourceStartNs.toString()],
      ["source.message_end_time", formatNanoseconds(input.sourceEndNs)],
      ["source.message_end_time_ns", input.sourceEndNs.toString()],
      ["slice.start_time", formatNanoseconds(input.sliceStartNs)],
      ["slice.start_time_ns", input.sliceStartNs.toString()],
      ["slice.end_time_exclusive", formatNanoseconds(input.sliceEndNs)],
      ["slice.end_time_exclusive_ns", input.sliceEndNs.toString()],
      ["slice.selected_topics_json", JSON.stringify(topics)],
      ["slice.created_at", formatNanoseconds(createdAtNs)]
    ])
  };
}
