import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type Stage =
  | 'commenting'
  | 'bootstrapping'
  | 'prototyping'
  | 'testing'
  | 'maintaining'
  | 'drifting'
  | 'hibernating';

export interface StageMeta {
  rank: number;
  label: string;
  description: string;
  progress: number;
  className: string;
  barClassName: string;
}

export const STAGES: Record<Stage, StageMeta> = {
  commenting: {
    rank: 0,
    label: 'Commenting',
    description: "Initial status — it's an idea people are commenting on",
    progress: 10,
    className: 'bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-200 dark:border-yellow-800',
    barClassName: 'bg-yellow-400',
  },
  bootstrapping: {
    rank: 1,
    label: 'Bootstrapping',
    description: 'People and resources are being recruited to start',
    progress: 30,
    className: 'bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-200 dark:border-yellow-800',
    barClassName: 'bg-yellow-500',
  },
  prototyping: {
    rank: 2,
    label: 'Prototyping',
    description: 'Something is being built',
    progress: 60,
    className: 'bg-blue-100 text-blue-900 border-blue-300 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-800',
    barClassName: 'bg-blue-400',
  },
  testing: {
    rank: 3,
    label: 'Testing',
    description: 'Something has been built and some people are using it',
    progress: 85,
    className: 'bg-blue-100 text-blue-900 border-blue-300 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-800',
    barClassName: 'bg-blue-500',
  },
  maintaining: {
    rank: 4,
    label: 'Maintaining',
    description: 'The project is publicly accessible, useable, and responding to ongoing feedback',
    progress: 100,
    className: 'bg-green-100 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-200 dark:border-green-800',
    barClassName: 'bg-green-500',
  },
  drifting: {
    rank: 5,
    label: 'Drifting',
    description: 'The project is still usable but not being actively maintained',
    progress: 100,
    className: 'bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-200 dark:border-yellow-800 opacity-80',
    barClassName: 'bg-yellow-400 opacity-70',
  },
  hibernating: {
    rank: 6,
    label: 'Hibernating',
    description: 'The project is not currently usable or maintained',
    progress: 100,
    className: 'bg-red-100 text-red-900 border-red-300 dark:bg-red-900/30 dark:text-red-200 dark:border-red-800 opacity-80',
    barClassName: 'bg-red-400 opacity-70',
  },
};

function asStage(value: string): Stage {
  return (value in STAGES ? value : 'commenting') as Stage;
}

interface StageBadgeProps {
  stage: string;
  className?: string;
}

export function StageBadge({ stage, className }: StageBadgeProps) {
  const meta = STAGES[asStage(stage)];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
            meta.className,
            className,
          )}
        >
          {meta.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{meta.description}</TooltipContent>
    </Tooltip>
  );
}

interface StageProgressProps {
  stage: string;
  showLabel?: boolean;
}

export function StageProgressBar({ stage, showLabel = true }: StageProgressProps) {
  const meta = STAGES[asStage(stage)];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="w-full flex items-center gap-3" aria-label={`Stage: ${meta.label}`}>
          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn('h-full transition-all', meta.barClassName)}
              style={{ width: `${meta.progress}%` }}
            />
          </div>
          {showLabel && <StageBadge stage={stage} />}
        </div>
      </TooltipTrigger>
      <TooltipContent>{meta.description}</TooltipContent>
    </Tooltip>
  );
}
