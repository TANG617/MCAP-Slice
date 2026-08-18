import { describe, expect, it, vi } from "vitest";
import type { URDFJoint, URDFRobot } from "urdf-loader";

import { applyJointConfiguration, resetJointConfiguration } from "../src/webview/RobotView";

function joint(jointType: URDFJoint["jointType"], lower = -1, upper = 1): {
  value: URDFJoint;
  setValue: ReturnType<typeof vi.fn>;
} {
  const setValue = vi.fn<(value: number) => boolean>().mockReturnValue(true);
  return { value: {
    jointType,
    jointValue: [0],
    limit: { lower, upper, effort: 0, velocity: 0 },
    ignoreLimits: false,
    setJointValue: setValue
  } as unknown as URDFJoint, setValue };
}

describe("robot JointState mapping", () => {
  it("resets defaults, applies raw values, and reports mapping diagnostics", () => {
    const shoulder = joint("revolute");
    const slide = joint("prismatic", 0, 0.5);
    const fixed = joint("fixed");
    const robot = {
      joints: { shoulder: shoulder.value, slide: slide.value, fixed: fixed.value }
    } as unknown as Pick<URDFRobot, "joints">;

    const stats = applyJointConfiguration(
      robot,
      new Map([["shoulder", 0], ["slide", 0.1]]),
      ["shoulder", "unknown", "fixed"],
      [1.5, 2, 0]
    );

    expect(stats).toEqual({ matched: 1, total: 2, unknown: 1, missing: 1, outOfLimit: 1 });
    expect(shoulder.setValue).toHaveBeenNthCalledWith(1, 0);
    expect(shoulder.setValue).toHaveBeenNthCalledWith(2, 1.5);
    expect(slide.setValue).toHaveBeenCalledWith(0.1);
    expect(fixed.setValue).not.toHaveBeenCalled();
    expect(shoulder.value.ignoreLimits).toBe(false);
  });

  it("restores defaults when there is no state and propagates master values to mimic joints", () => {
    const master = joint("revolute");
    const mimic = joint("revolute");
    master.setValue.mockImplementation((value: number) => {
      mimic.setValue(value * 2 + 0.1);
      return true;
    });
    const robot = {
      joints: { master: master.value, mimic: mimic.value }
    } as unknown as Pick<URDFRobot, "joints">;
    const defaults = new Map([["master", 0.2]]);

    applyJointConfiguration(robot, defaults, ["master"], [0.7]);
    expect(mimic.setValue).toHaveBeenLastCalledWith(1.5);

    resetJointConfiguration(robot, defaults);
    expect(master.setValue).toHaveBeenLastCalledWith(0.2);
    expect(mimic.setValue).toHaveBeenLastCalledWith(0.5);
  });
});
