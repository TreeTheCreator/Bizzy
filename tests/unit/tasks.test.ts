import { describe, expect, it } from "vitest";
import { nextDueDate } from "@/server/modules/tasks/service";

describe("nextDueDate", () => {
  it("returns null for non-recurring tasks", () => {
    expect(nextDueDate("2026-11-12", "none")).toBeNull();
  });
  it("adds a day / a week", () => {
    expect(nextDueDate("2026-12-31", "daily")).toBe("2027-01-01");
    expect(nextDueDate("2026-11-12", "weekly")).toBe("2026-11-19");
  });
  it("adds a month and clamps to the month's last day", () => {
    expect(nextDueDate("2026-11-12", "monthly")).toBe("2026-12-12");
    expect(nextDueDate("2027-01-31", "monthly")).toBe("2027-02-28");
    expect(nextDueDate("2028-01-31", "monthly")).toBe("2028-02-29");
    expect(nextDueDate("2026-12-15", "monthly")).toBe("2027-01-15");
  });
  it("counts from today when there is no due date", () => {
    expect(nextDueDate(null, "daily", new Date("2026-11-12T15:00:00Z"))).toBe("2026-11-13");
  });
});
