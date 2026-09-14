import { RefreshCw } from "lucide-react";
import { Badge } from "../../../components/ui/badge";
import { formatModelRetryDelay, humanizeModelFailureKind } from "../model-reliability";
import type { TurnStreamRetry } from "../turn-stream-state";

type ModelRetryIndicatorProps = {
  retry: TurnStreamRetry | null | undefined;
};

export function ModelRetryIndicator({ retry }: ModelRetryIndicatorProps) {
  if (retry === null || retry === undefined) return null;

  return (
    <div
      className="my-5 flex items-start gap-2.5 rounded-lg border border-orange-200/80 bg-orange-50/70 px-3.5 py-2.5 text-[#8a4b2c]"
      aria-label="Retrying model request"
    >
      <RefreshCw size={15} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">Retrying model request</p>
        <p className="mt-0.5 text-[11px] leading-5">
          Attempt {retry.nextAttempt} · {humanizeModelFailureKind(retry.kind)} · retrying in {formatModelRetryDelay(retry.delayMs)}
        </p>
      </div>
      <Badge tone="orange" className="shrink-0">Attempt {retry.nextAttempt}</Badge>
    </div>
  );
}
