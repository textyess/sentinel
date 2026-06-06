"use client";

import { useParams } from "next/navigation";
import { RunReport } from "@/components/runs/run-report";

export default function RunPage() {
    const params = useParams<{ runId: string }>();
    const runId = Array.isArray(params.runId) ? (params.runId[0] ?? "") : params.runId;
    return <RunReport runId={runId} />;
}
