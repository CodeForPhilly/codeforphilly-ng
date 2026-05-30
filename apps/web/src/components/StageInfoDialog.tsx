import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { STAGES, type Stage } from '@/components/StageBadge';
import { cn } from '@/lib/utils';

interface StageInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project's current stage; highlighted in the list. */
  currentStage?: string;
}

// Stage order matches the rank from specs/behaviors/project-stages.md.
const ORDERED_STAGES: readonly Stage[] = [
  'commenting',
  'bootstrapping',
  'prototyping',
  'testing',
  'maintaining',
  'drifting',
  'hibernating',
];

export function StageInfoDialog({ open, onOpenChange, currentStage }: StageInfoDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>What does each stage mean?</DialogTitle>
          <DialogDescription>
            Every project carries one of seven lifecycle stages. See{' '}
            <span className="italic">specs/behaviors/project-stages.md</span> for the canonical
            source.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-3 mt-2">
          {ORDERED_STAGES.map((s) => {
            const meta = STAGES[s];
            const isCurrent = s === currentStage;
            return (
              <li
                key={s}
                className={cn(
                  'rounded-md border px-3 py-2',
                  isCurrent
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-card',
                )}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold">{meta.label}</span>
                  {isCurrent && (
                    <span className="text-xs text-primary">(this project)</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{meta.description}</p>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
