/**
 * Hand-curation pass over the backfilled events (plans/events-legacy-backfill.md
 * → "Then curated by hand"). Applies reviewed edits through the running dev
 * API's own write routes so every change is validated the way a staff edit
 * would be. One-off; run against the dev API on :3001.
 *
 *   API=http://localhost:3001 TOKEN=<staff cfp_session> npx tsx scripts/curate-events-backfill.ts
 */
const API = process.env["API"] ?? "http://localhost:3001";
const TOKEN = process.env["TOKEN"];
if (!TOKEN) throw new Error("TOKEN (cfp_session) is required");

/** ISO instant for a Philadelphia wall-clock time. */
function ny(date: string, time: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const local = Date.parse(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:00Z`,
  );
  const offsetMs = local - guess.getTime();
  return new Date(guess.getTime() - offsetMs).toISOString();
}

type Agenda = Array<{
  startsAt: string;
  endsAt?: string | null;
  title: string;
  description?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
}>;
const slot = (
  date: string,
  start: string,
  end: string | null,
  title: string,
  description: string | null = null,
) => ({
  startsAt: ny(date, start),
  endsAt: end ? ny(date, end) : null,
  title,
  description,
  venueName: null,
  venueAddress: null,
});

/** Skip the first FROM calls (resume after a rate-limit window). */
const FROM = Number(process.env["FROM"] ?? 0);
let calls = 0;
async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  if (calls++ < FROM) return;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      cookie: `cfp_session=${TOKEN}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let msg: string;
  try {
    const json = JSON.parse(text) as {
      success?: boolean;
      error?: { message?: string };
      data?: { slug?: string };
    };
    msg =
      json.success === false
        ? `ERROR ${json.error?.message}`
        : (json.data?.slug ?? "ok");
  } catch {
    msg = res.ok ? "ok" : `ERROR ${res.status} ${text.slice(0, 120)}`;
  }
  console.log(`${method} ${path} → ${res.status} ${msg}`);
}
const patchEvent = (slug: string, body: Record<string, unknown>) =>
  call("PATCH", `/api/events/${slug}`, body);
const patchSeries = (slug: string, body: Record<string, unknown>) =>
  call("PATCH", `/api/event-series/${slug}`, body);

const INDY_HALL_2019 = {
  venueName: "Indy Hall",
  venueAddress: "399 Market St, 3rd Floor, Philadelphia, PA 19106",
};
const INDY_HALL_2020 = {
  venueName: "Indy Hall",
  venueAddress: "399 Market St, Suite 360, Philadelphia, PA 19106",
};
const INDY_HALL = {
  venueName: "Indy Hall",
  venueAddress: "709 N 2nd St, 3rd Floor, Philadelphia, PA 19123",
};
const CITY_HALL = {
  venueName: "City Hall, Caucus Room",
  venueAddress: "1400 John F Kennedy Blvd, Philadelphia, PA 19107",
};
const INNOVATION_LAB = {
  venueName: "Philadelphia Innovation Lab",
  venueAddress: "1401 John F Kennedy Blvd, 16th Floor, Philadelphia, PA 19102",
};
const PROMPTWORKS = {
  venueName: "PromptWorks",
  venueAddress: "123 S Broad St, Suite 2400, Philadelphia, PA 19109",
};

const HACK_NIGHT_2019 =
  "Work with your team on your project. We provide the space and the food.";
const HACK_NIGHT_2020 =
  "Space and time for teams to regroup and work on their analyses. Some nights include a workshop to help with analysis and presentations.";
const VIRTUAL_2023 =
  "Teams formed over kickoff weekend meet online to hack on their projects together. Each team has a Code for Philly Google Meet room and its own Slack channel; Tuesdays 6–8:30 pm is the suggested time, but teams can meet whenever suits them.";
const IN_PERSON_2023 =
  "Teams meet in person at Indy Hall, our HQ in Northern Liberties, to hack on their projects together. Dinner will be served.";

const HACK_NIGHT_2026 = `Come work on civic tech projects with us. Bring a laptop if you can: if your skills fit a team's needs, you can start contributing the same night.

Many projects have hybrid setups. To join virtually, [join our Slack](https://codeforphilly.org/chat) and ask the project lead for the video link.

There will be food, with a vegan option. Space is limited, so if your plans change please cancel your RSVP to make room for someone on the waitlist.

## Getting in

A sign on the door has a number to text for the door code. Take the elevator (or the stairs) at the back of the hall to the 3rd floor, then turn left out of the elevator lobby. The door code only works until 8 pm; after that, message someone inside on Slack to let you in.`;

const hackNightAgenda = (date: string): Agenda => [
  slot(date, "18:00", null, "Doors open"),
  slot(date, "18:00", "18:15", "Food and schmoozing"),
  slot(date, "18:15", "18:30", "Announcements and project introductions"),
  slot(date, "18:30", "20:30", "Hack on projects"),
];

async function main(): Promise<void> {
  // ---------------------------------------------------------------- series
  await patchSeries("monthly-hack-nights", {
    description: `Code for Philly's regular meetup: the second Tuesday of every month, 6–8:30 pm at Indy Hall in Northern Liberties. Project teams work side by side, and newcomers find a project that fits their skills. No coding experience required.

Each hack night opens with food and introductions from the project leads, then the room gets to work. Bring a laptop if you have one. Many projects also have hybrid setups: [join our Slack](https://codeforphilly.org/chat) and ask a project lead for the video link.`,
  });

  await patchSeries("launchpad-2018", {
    description: `![Civic Engagement Launchpad 2018](/api/attachments/event-series/launchpad-2018/media-1242.png)

## Overview

The Civic Engagement Launchpad is a month-long, project-launching "sprint" focused on improving democratic systems and creating tools for greater civic engagement. Multi-disciplinary teams work on projects that are public-minded, open source, and not-for-profit.

Evolving from weekend [hackathons](https://codeforphilly.org/pages/hackathons), launchpads provide the resources, setting, and framework for teams and individuals who want to make a lasting positive impact. Project teams have a chance to bond, collaborate, work with stakeholders, and develop viable projects that are sustainable long after Launchpad's conclusion.

## How it ran

- Launchpad kicked off on Friday, April 27th with Brainstorming Night, where participants mingled and discussed opportunity statements and project ideas.
- On Saturday, April 28th, participants joined or formed a group of their choosing and took part in two workshops on team expectations and outlining project goals.
- Throughout May, teams attended workshops and project hack nights.
- The month culminated in Demo Night on May 22nd, where teams introduced their projects to expert panelists and the Code for Philly community.

[Find the list of 2018 projects here.](https://codeforphilly.org/blog/civic_engagement_launchpad_projects)

## Who should come?

We welcome anyone who wants to engage with their fellow citizens and local government. [The best teams bring together a diverse set of talents and experiences.](https://codeforphilly.org/blog/launchpad_2018--civic_tech_takes_a_village) Some of the best ideas come from those closest to the civic challenge — that means you!

## What we look for in projects

Past projects have brought transparency to the people who influence elections, visualized election results, documented open offices and running requirements, and visualized the flow of campaign finance data. If your idea increases civic engagement, helps residents engage with local government or the democratic process, or uses data or technology to improve the lives of residents, we want it.

## Our wonderful partners

[![Technically Philly](/api/attachments/event-series/launchpad-2018/media-1248.jpg)](https://technical.ly/philly/)

[![Azavea](/api/attachments/event-series/launchpad-2018/media-1015.png)](https://www.azavea.com/)

[![High Brew Coffee](/api/attachments/event-series/launchpad-2018/media-1247.png)](http://www.highbrewcoffee.com/)

[![Philly Tech Week 2018](/api/attachments/event-series/launchpad-2018/media-1253.png)](http://2018.phillytechweek.com/)

[![DigitalOcean](/api/attachments/event-series/launchpad-2018/media-1269.png)](https://www.digitalocean.com)`,
  });

  await patchSeries("launchpad_2019", {
    description: `![Launchpad 2019: Phundamentals](/api/attachments/event-series/launchpad_2019/media-1501.jpg)

Code for Philly's Launchpad is a multi-event hackathon over the course of a month, for project teams of multi-disciplinary volunteers to form and collaborate with community stakeholders and subject matter experts alike. Projects investigate opportunities for civic progress and prototype new solutions using user-centered design, open data, and open source technology.

## Phundamentals

For 2019, we took Launchpad back to basics… Phundamentals, if you may.

Project teams explored civic tech solutions that help provide equitable access to Philly's (re)defined set of basic needs. What are those 21st century basic needs? That was up to us to decide. We started a conversation around the resources and services that are necessary to thrive in Philadelphia today, and formed project teams to improve access for Philadelphians.

The proposals around these shared needs, and the projects that formed from them, focused on anything we collectively rely on. The big ones, like access to food, water, and shelter? Of course. Emergency services, digital access, and healthcare? Without a doubt. Personal well-being, education, and job opportunities — yes, yes, and yes.

## Learn more

- [Technical.ly Philly on this year's Launchpad teams](https://technical.ly/philly/2019/09/13/code-for-philly-launchpad-phundamentals-hackathon-projects/)
- [What is Launchpad again? (Launchpad 101)](https://codeforphilly.org/blog/what_is_launchpad_again--launchpad_101)
- [Why Launchpad is such a great time to get involved](https://codeforphilly.org/blog/why_launchpad_is_a_great_opportunity_to_get_involved)
- [A new jawn: Launchpad 2019, back to basics](https://codeforphilly.org/blog/a_new_jawn-launchpad_2019--back_to_basics)

## Thank you to our sponsors

![Technically](/api/attachments/event-series/launchpad_2019/media-1507.gif) ![Esri](/api/attachments/event-series/launchpad_2019/media-1508.png) ![PromptWorks](/api/attachments/event-series/launchpad_2019/media-1509.png) ![Linode](/api/attachments/event-series/launchpad_2019/media-1510.png) ![Vistar Media](/api/attachments/event-series/launchpad_2019/media-1521.png) ![Excite Center](/api/attachments/event-series/launchpad_2019/media-1533.png) ![The Meet Group](/api/attachments/event-series/launchpad_2019/media-1540.png)`,
  });

  await patchSeries("datahack2020", {
    title: "2020 Data Hack",
    description: `## What the hack?

Code for Philly, DataPhilly, R Ladies Philly, the Philly Data Jawn, Health Federation of Philadelphia, and Prevention Point hosted a data science hackathon to answer pertinent questions around the opioid crisis in Philadelphia. The goals: provide health organizations with insights that may normally be unavailable to them, and create analyses that help inform the public about the opioid epidemic in our city.

Hackathon planners worked with our partners to identify and clean relevant datasets for three broad questions:

1. Can we visualize the recovery process, both to build understanding in the general public and to make better tools for warm handoffs?
2. What have been the effects of granting citizens access to Narcan?
3. How many IV drug users are in Philadelphia?

## How it worked

The hack began on Friday, February 7 with a kickoff night where partner organizations presented what they do and why these questions matter to them. The next day, participants had several hours to form a team, consider the questions, and devise a plan for their analysis. Over the following five weeks, teams worked on their analyses and wrote their presentations.

Participants were not required to attend every event: hack nights gave teams a space and time to regroup, and some included workshops to help with analysis and final presentations. To give each team enough time on presentation night, there were no more than 12 teams, each with as many members as they wanted.

## Thanks to our sponsors

Presenting sponsor:

[![AT&T](/api/attachments/event-series/datahack2020/media-1403.png)](https://www.att.com/)

With additional support from:

[![CompassRed](/api/attachments/event-series/datahack2020/media-1582.png)](http://www.compassred.com)`,
  });

  await patchSeries("launchpad-2023", {
    title: "Launchpad 2023: Third Places",
    description: `## About Launchpad

Code for Philly's Launchpad is a multi-event hackathon over the course of a month, for project teams of multidisciplinary volunteers to form and collaborate with community stakeholders and subject-matter experts alike. Projects investigate opportunities for civic progress and prototype new solutions using user-centered design, open data, and open source technology. The 2023 Launchpad kicked off new projects that spring.

## Theme

This year's theme was "third places": the physical and digital spaces where we socialize outside the home (the first place) and work (the second place).

Examples of third places include:

- Parks
- Libraries
- Book stores
- Community spaces

Projects from this year's Launchpad looked like:

- Volunteer management software
- Software that helps an organization create and manage community events
- Tools for cross-community communication
- Virtual spaces that supplement physical spaces
- A data inventory of existing spaces and ways to help people discover them

## Taking part

The 2023 Launchpad ran from March 31 to May 10. Volunteers of all kinds were welcome, with no coding skills or experience required: developers, UX researchers and designers, product and project managers, social media mavens, community outreach folks, and everyone in between.`,
  });

  // ---------------------------------------------------------- Launchpad 2018
  await patchEvent("2018-04-27-kickoff-weekend-brainstorming", {
    title: "Brainstorming Night",
    slug: "2018-04-27-brainstorming-night",
    ...CITY_HALL,
    description: `An evening of brainstorming and discussion at the historic heart of our city. Bringing together Philadelphians from all over the city, coders and non-coders alike, we put our heads together to create and discuss project ideas. Some of the best ideas come from those closest to the civic challenge — that means you!

Past projects have brought transparency to the people who influence elections, visualized election results, documented open offices and running requirements, and visualized the flow of campaign finance data. For more inspiration, read [Technical.ly's recap of the previous year's projects](https://technical.ly/philly/2017/03/28/code-for-philly-civic-engagement-launchpad-kickoff/).

A unique chance to gather within the modern-day heart of our local government: City Hall's Caucus Room.`,
  });
  await patchEvent("2018-04-28-kickoff-weekend-work-day", {
    title: "Opening Work Day",
    slug: "2018-04-28-opening-work-day",
    ...INNOVATION_LAB,
    description: `Teams organize around the ideas presented the night before. The day includes structured project design, opportunity discovery, and team collaboration workshops, so projects new and returning can make the most of their time, energy, and impact. The City of Philadelphia's Innovation Management Corps partnered with us to facilitate some of the Saturday and in-month workshops.`,
    agenda: [
      slot(
        "2018-04-28",
        "09:00",
        "09:45",
        "Participant sign-in and light breakfast",
        "Consider the project ideas that most interest you; Friday night's easels are posted throughout the room.",
      ),
      slot("2018-04-28", "09:45", null, "Opening remarks"),
      slot("2018-04-28", "10:05", null, "Team formation"),
      slot(
        "2018-04-28",
        "10:25",
        null,
        "Workshops",
        "Led by the City's Office of Innovation Management.",
      ),
      slot("2018-04-28", "12:30", null, "Lunch is served"),
      slot("2018-04-28", "13:30", null, "Open team work and hacking"),
      slot("2018-04-28", "17:15", null, "Dinner is served"),
      slot(
        "2018-04-28",
        "21:00",
        null,
        "Doors close",
        "Teams are not required to stay until 9 pm.",
      ),
    ],
  });
  await patchEvent("2018-05-22-demo-night", {
    endsAt: ny("2018-05-22", "20:30"),
    venueName: "Harrisburg University – Philadelphia",
    venueAddress: "1500 Market St, Philadelphia, PA 19102",
    description:
      "Time to celebrate a month of hard work. Teams present their experiences and progress, expert panelists provide feedback and ideas, and light refreshments are served.",
  });

  // ---------------------------------------------------------- Launchpad 2019
  await patchEvent("2019-09-06-friday-night-kick-off", {
    title: "Friday Night Kickoff",
    slug: "2019-09-06-friday-night-kickoff",
    description:
      "A night of project brainstorming in the City Council Caucus Room at City Hall.",
  });
  await patchEvent("2019-09-07-opening-work-day", {
    title: "Opening Work Day",
    ...PROMPTWORKS,
    description: `Join a team, pick a civic problem worth solving, get to work!

Brainstorming night was fun, but now it's time to get to work. The day is filled with guest speakers, team formation, and workshops to get you ready for some civic hacking, with technical mentors on hand to help teams jump-start their projects.`,
  });
  await patchEvent("2019-09-10-launchpad-hack-night", {
    title: "Hack Night & Workshop #1",
    slug: "2019-09-10-hack-night",
    ...INDY_HALL_2019,
    description: HACK_NIGHT_2019,
  });
  await patchEvent("2019-09-17-launchpad-hack-night", {
    title: "Hack Night & Workshop #2",
    slug: "2019-09-17-hack-night",
    description: HACK_NIGHT_2019,
  });
  await patchEvent("2019-09-21-launchpad-saturday-hack-day", {
    title: "Saturday Hack Day: National Day of Civic Hacking",
    slug: "2019-09-21-saturday-hack-day",
    venueAddress: "3401 Market St, Suite 100, Philadelphia, PA 19104",
    description:
      "Work on your project alongside thousands of other civic hackers in cities across the country, as part of National Day of Civic Hacking.",
  });
  await patchEvent("2019-09-24-launchpad-hack-night", {
    title: "Hack Night & Workshop #4",
    slug: "2019-09-24-hack-night",
    ...INDY_HALL_2019,
    description: HACK_NIGHT_2019,
  });
  await patchEvent("2019-09-28-3rd-saturday-work-day", {
    title: "Saturday Work Day & Demo Prep Workshop",
    slug: "2019-09-28-saturday-work-day",
    venueAddress: "1315 Walnut St, Suite 201, Philadelphia, PA 19107",
    description:
      "A project work day, plus a workshop on preparing your demo for Demo Night.",
  });
  await patchEvent("2019-10-01-demo-night", {
    description: "Teams present their work and celebrate with the community.",
  });

  // ---------------------------------------------------------- Data Hack 2020
  await patchEvent("2020-02-07-partner-presentations", {
    description:
      "Partner organizations present what they do and why the hack's questions matter to them, then the organizers walk through how the hack will run.",
    agenda: [
      slot("2020-02-07", "18:00", "18:30", "Doors open, food available"),
      slot("2020-02-07", "18:30", null, "Welcome and hack overview"),
      slot("2020-02-07", "18:45", null, "Health Federation of Philadelphia"),
      slot("2020-02-07", "19:05", null, "Prevention Point"),
      slot("2020-02-07", "19:30", null, "Partner Q&A"),
      slot("2020-02-07", "19:45", null, "Hack organization and outcomes"),
    ],
  });
  await patchEvent("2020-02-08-hackathon-kickoff", {
    description:
      "Form a team, choose a question, and plan your analysis. Lunch is provided.",
    agenda: [
      slot("2020-02-08", "09:00", null, "Doors open"),
      slot("2020-02-08", "09:30", null, "Welcome and overview"),
      slot("2020-02-08", "10:15", null, "Brainstorming session"),
      slot("2020-02-08", "11:30", null, "Lunch"),
      slot(
        "2020-02-08",
        "12:15",
        null,
        "Team formation and analysis development",
      ),
      slot("2020-02-08", "14:00", null, "Doors close"),
    ],
  });
  for (const [slug, venue] of [
    ["2020-02-11-hack-night", INDY_HALL_2020],
    ["2020-02-18-hack-night", {}],
    ["2020-02-25-hack-night", INDY_HALL_2020],
    ["2020-03-03-hack-night", PROMPTWORKS],
    ["2020-03-10-hack-night", INDY_HALL_2020],
  ] as const) {
    await patchEvent(slug, { description: HACK_NIGHT_2020, ...venue });
  }
  await patchEvent("2020-03-17-team-presentations", {
    description: `Teams present their analyses to the partner organizations and the community.

## Getting in

Azavea is on the 5th floor of 990 Spring Garden Street. Access to the building requires stairs or a wheelchair lift; there is a lift at the north and south entrances, coordinated by the building reception desk, so let us know if you plan to use it. Sign in at the front desk with building security, take the elevator to the 5th floor, and follow the signs into the event space.

You are welcome to use Azavea's in-office bicycle storage room if you bike to the event; the building is also on the #43 bus and other transit. If you have a visual, verbal, auditory, or other impairment that might affect your visit, let us know what accommodations you need. Use whichever restroom you are most comfortable with; Azavea also offers a lactation room and refrigeration for breast milk and medications.`,
  });

  // ---------------------------------------------------------- Launchpad 2023
  await patchEvent("2023-03-31-friday-night-kickoff", {
    description: `A kickoff night for civic tech enthusiasts to brainstorm open source solutions around this year's theme, "third places."

**Dinner will be served!**

## Getting to the Caucus Room

Enter City Hall from the northeast corner, across the street from the Notary Hotel; there is a ramp. You will need to show photo ID and go through a metal detector. Go to the 4th floor, where people will be helping folks in.`,
    agenda: [
      slot("2023-03-31", "18:00", null, "Doors open"),
      slot(
        "2023-03-31",
        "18:00",
        "18:30",
        "Dinner",
        "There will be leftovers.",
      ),
      slot("2023-03-31", "18:30", "18:45", "Opening remarks"),
      slot("2023-03-31", "18:45", "19:30", '"Third place" speakers'),
      slot(
        "2023-03-31",
        "19:30",
        "21:00",
        "Idea generation and planning for Saturday",
      ),
    ],
  });
  await patchEvent("2023-04-01-opening-work-day", {
    ...INNOVATION_LAB,
    description: `Join a team, pick a civic problem worth solving, get to work!

Brainstorming is over and it's time to get to work. The day is filled with guest speakers, team formation, and workshops, with technical mentors on hand to help teams jump-start their projects.

Breakfast, lunch, and dinner will be served.`,
    agenda: [
      slot("2023-04-01", "09:00", "09:45", "Sign-in and breakfast"),
      slot("2023-04-01", "09:45", null, "Opening remarks"),
      slot("2023-04-01", "10:05", null, "Team formation"),
      slot(
        "2023-04-01",
        "10:25",
        "12:30",
        "Workshops",
        "Four 30-minute workshops on topics that will help with your projects.",
      ),
      slot("2023-04-01", "12:30", null, "Lunch"),
      slot("2023-04-01", "13:30", null, "Open teamwork and hacking"),
      slot("2023-04-01", "17:15", null, "Dinner"),
      slot("2023-04-01", "19:00", null, "Doors close"),
    ],
  });
  // One laddr segment covered five Tuesdays; one venue, one span, one event.
  await call("DELETE", "/api/events/2023-04-04-weekly-hack-nights");
  for (const [date, kind, meetupUrl] of [
    ["2023-04-04", "virtual", null],
    [
      "2023-04-11",
      "in-person",
      "https://www.meetup.com/code-for-philly/events/292243516/",
    ],
    ["2023-04-18", "virtual", null],
    ["2023-04-25", "virtual", null],
    [
      "2023-05-09",
      "in-person",
      "https://www.meetup.com/code-for-philly/events/292243997/",
    ],
  ] as const) {
    const virtual = kind === "virtual";
    await call("POST", "/api/events", {
      title: virtual ? "Virtual Hack Night" : "Hack Night at Indy Hall",
      slug: `${date}-${virtual ? "virtual-hack-night" : "hack-night"}`,
      seriesSlug: "launchpad-2023",
      startsAt: ny(date, "18:00"),
      endsAt: ny(date, "20:30"),
      ...(virtual ? { venueName: "Online", venueAddress: null } : INDY_HALL),
      meetupUrl,
      description: virtual ? VIRTUAL_2023 : IN_PERSON_2023,
    });
  }
  await patchEvent("2023-05-10-showcase-night", {
    description:
      "Teams demo their work and the community celebrates a month of building. Dinner will be served.",
  });

  // ------------------------------------------------------ Monthly Hack Nights
  for (const date of ["2026-09-08", "2026-10-13", "2026-11-10", "2026-12-08"]) {
    await patchEvent(`${date}-hack-night`, {
      description: HACK_NIGHT_2026,
      agenda: hackNightAgenda(date),
    });
  }
}

await main();
