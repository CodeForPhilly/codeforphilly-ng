import { CalendarPlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { googleCalendarUrl, isPastEvent, outlookCalendarUrl, type CalendarLinkEvent } from '@/lib/event-time';

interface AddToCalendarEvent extends CalendarLinkEvent {
  status: 'draft' | 'scheduled' | 'cancelled';
  icsUrl: string;
}

/** Offered only while the event is scheduled and has not ended (specs/behaviors/events.md#add-to-calendar). */
export function canAddToCalendar(event: Pick<AddToCalendarEvent, 'status' | 'endsAt'>, now: Date = new Date()): boolean {
  return event.status === 'scheduled' && !isPastEvent(event.endsAt, now);
}

interface AddToCalendarMenuProps {
  event: AddToCalendarEvent;
  /** "button" is the labelled control on event detail; "icon" is the compact one on cards. */
  variant?: 'button' | 'icon';
}

/**
 * One "Add to calendar" control with three choices: Google Calendar and
 * Outlook.com as prefilled links, and the `.ics` download for Apple Calendar
 * and everything else. Renders nothing when the event can't be added.
 */
export function AddToCalendarMenu({ event, variant = 'button' }: AddToCalendarMenuProps) {
  if (!canAddToCalendar(event)) return null;
  const origin = window.location.origin;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === 'icon' ? (
          <Button variant="ghost" size="icon" aria-label={`Add ${event.title} to calendar`}>
            <CalendarPlusIcon />
          </Button>
        ) : (
          <Button variant="outline" size="sm">
            <CalendarPlusIcon />
            Add to calendar
          </Button>
        )}
      </DropdownMenuTrigger>
      {/* Size to the labels, not the trigger, so no choice wraps (the shared content defaults to the trigger's width). */}
      <DropdownMenuContent align={variant === 'icon' ? 'end' : 'start'} className="w-auto">
        <DropdownMenuItem asChild>
          <a href={googleCalendarUrl(event, origin)} target="_blank" rel="noopener noreferrer">
            Google Calendar
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={outlookCalendarUrl(event, origin)} target="_blank" rel="noopener noreferrer">
            Outlook.com
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={event.icsUrl} download>
            Apple Calendar / .ics
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
