"use client";

import { useEffect } from "react";
import type { WidgetStep as Step } from "@/lib/core/widget";
import { reportStep } from "./widget-embed";

// A step inside a section: the booking, its fresh confirmation ("booked") or a confirmation opened later. Renders nothing.
export function WidgetStep({ step, token }: Step) {
  useEffect(() => {
    reportStep({ step, token });
  }, [step, token]);
  return null;
}
