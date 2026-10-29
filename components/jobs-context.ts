"use client";

import { createContext } from "react";
import type { JobRecord } from "@/src/core";

/** Background-job observability channel (contracts.ts "THE ASYNC PROTOCOL" §4). */
export const JobsContext = createContext<JobRecord[]>([]);
