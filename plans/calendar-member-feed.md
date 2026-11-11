---
status: done
pr: 260
depends: [events-core]
specs:
  - specs/behaviors/events.md
  - specs/api/events.md
  - specs/screens/event-detail.md
  - specs/screens/events-index.md
---

# Plan: a calendar feed per member, and one Add to calendar button

## Scope

The site already publishes one subscription feed of every event and two
text links on the event page ("Add to Google Calendar", "Download .ics").
Two gaps, raised in #website-relaunch as "ical subscription feed for
users, add to calendar button for events":

- A member who subscribes gets every event, not the ones they said yes
  to. Add a **member feed**: the same feed narrowed to one person's RSVPs.
- Adding a single event to a calendar is two unlabelled-as-a-group links
  on one screen only. Replace them with **one "Add to calendar" button**
  whose menu offers Google Calendar, Outlook.com and Apple Calendar /
  .ics, and put the same menu on event cards.

**In:** `GET /api/events/feed.ics?attendee=<slug>`; the `AddToCalendarMenu`
component on event detail and on the full event cards (events index,
series page); the signed-in Subscribe menu on `/events`; the Outlook.com
link builder. **Out:** private or tokenized feeds (RSVPs are public, so
there is nothing to protect); a feed link on the member's profile or
account page; the home strip's compact cards and its "Subscribe" link,
which keep their one RSVP action and the site feed; any change to the
emails.

## Implements

- [behaviors/events.md](../specs/behaviors/events.md#calendar-files) —
  the member feed as the fourth delivery form, and the new
  [Add to calendar](../specs/behaviors/events.md#add-to-calendar) section.
- [api/events.md](../specs/api/events.md#get-apieventsfeedics) — the
  `attendee` query parameter, calendar name, filename and errors.
- [screens/event-detail.md](../specs/screens/event-detail.md) — the
  button and its menu in place of the two links.
- [screens/events-index.md](../specs/screens/events-index.md) — the
  signed-in Subscribe menu and the card's Add to calendar control.

## Approach

1. **Feed.** `EventService.memberFeed(slug)` walks `rsvpsByPerson`, maps
   each RSVP to its event and applies the same window as `feedEvents`
   (both now share `#feedWindow`). `buildFeedIcs` takes the calendar name.
   The route keeps one path, `feed.ics`, and branches on `attendee`:
   unknown or deactivated person is a 404 envelope, empty value a 422.
2. **Menu.** `apps/web/src/components/AddToCalendarMenu.tsx` on the
   existing shadcn `dropdown-menu`: a labelled outline button on detail,
   an icon button on cards. `canAddToCalendar` (scheduled and not ended)
   is the single visibility rule. `outlookCalendarUrl` joins
   `googleCalendarUrl` in `lib/event-time.ts`.
3. **Cards.** `EventCard` renders the menu for `variant="full"` in the
   same above-the-stretched-link slot the home strip's RSVP action uses.
4. **Subscribe.** `calendarFeedUrls(attendeeSlug?)` builds either feed's
   `webcal://` and `https://` forms; `SubscribeControl` becomes a menu
   when a viewer is signed in.
5. **Tests.** API: the member feed's contents, headers, withdrawal,
   empty calendar, 404s and 422. Web: the menus on detail, cards and the
   Subscribe control; the Outlook link builder.

## Validation

- [x] `GET /api/events/feed.ics?attendee=<slug>` with no session lists
  exactly the scheduled and cancelled events that person RSVP'd to inside
  the 90-day window, named `Code for Philly: <fullName>'s events`.
- [x] Withdrawing an RSVP removes the event from the member feed; a
  member with no RSVPs gets an empty, valid calendar.
- [x] An unknown or deactivated `attendee` answers `404 not_found` in the
  JSON envelope; an empty one `422`.
- [x] The site feed without `attendee` is unchanged.
- [x] Event detail shows one "Add to calendar" button whose menu has
  Google Calendar, Outlook.com and Apple Calendar / .ics; it is absent on
  drafts, cancelled and past events.
- [x] Full event cards for scheduled, upcoming events carry the same
  menu; cancelled, draft and past cards and the home strip do not.
- [x] Signed out, `/events` offers the site feed with "Copy feed URL";
  signed in, a menu offers "All events" and "Events I'm going to", each
  with a copy fallback.
- [x] `npm run type-check && npm run lint && npm test` clean.
- [ ] Checked in a browser: both menus open, the Google and Outlook.com
  links land on a prefilled event, the `.ics` opens in a calendar app, and
  a calendar app subscribes to the member feed over `webcal://`.

## Risks / unknowns

- **Outlook.com deeplink.** The `outlook.live.com/calendar/0/deeplink/compose`
  format is not a documented contract. The builder percent-encodes spaces
  (Outlook shows `+` literally) and sends line breaks as `<br>`; only a
  browser check against a real Outlook.com account confirms the result.
- **Handle renames.** The member feed is keyed by slug and the API does
  not follow slug history, so a calendar subscribed to an old handle stops
  updating after a rename. The spec says the member subscribes again.

## Notes

- **Browser check, November 11, 2026.** Run in headless Chrome against the
  `fixture` data with seeded events. The signed-in check used a session
  minted with `mintSessionFor` against localhost. Both menus open, keyboard
  included, and nothing overflows at 390px.
- **The last validation box stays open.** The Google link was followed as
  far as the sign-in screen with every parameter intact. Not done: an
  Outlook.com account seeing the prefilled form, the `.ics` opening in a
  real calendar app, and a calendar app subscribing over `webcal://`. Each
  needs a person with an account; see Follow-ups.
- **Two fixes came out of the check.** The menus now size to their labels
  instead of to the trigger (on cards the menu had been 8rem wide and its
  items wrapped). The Outlook body is HTML-escaped, because Outlook renders
  it as HTML.
- **Outlook.com parameters** were checked against
  InteractionDesignFoundation/add-event-to-calendar-docs (`outlook-web.md`,
  verified by its authors on August 19, 2026) and spatie/calendar-links.
  Microsoft does not document the format.
- **Slugs match case-sensitively** in `attendee`, as everywhere in the API.

## Follow-ups

- Open the Outlook.com link signed in to a real account, on desktop and on
  a phone, and confirm title, time, body and location are filled. Phones
  are a known weak spot on Microsoft's side.
- Open a downloaded `.ics` in a calendar app, and subscribe to a member
  feed over `webcal://` from Apple Calendar or Google Calendar; confirm an
  RSVP made or withdrawn shows at the next poll.
- The shared dropdown matches every menu's width to its trigger. The user
  menu and the About menu inherit this; consider a site-wide default.
- Dropdown group labels such as "All events" are not exposed to screen
  readers as group names.
