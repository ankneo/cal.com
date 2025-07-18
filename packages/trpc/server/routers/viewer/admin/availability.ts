import { google } from "googleapis";
import { z } from "zod";

import { getCalendar } from "@calcom/app-store/_utils/getCalendar";
import { getUserAvailability } from "@calcom/core/getUserAvailability";
import dayjs from "@calcom/dayjs";
import prisma from "@calcom/prisma";
import { availabilityUserSelect } from "@calcom/prisma/selects/user";

import { TRPCError } from "@trpc/server";

import { createProtectedRouter } from "../../../createRouter";

// Helper function to check if an event is location-only (should be filtered out)
function isLocationOnlyEvent(event: any): boolean {
  // 1. Check if it's transparent (doesn't block time)
  if (event.transparency === "transparent") return true;

  // 2. Check if it's a working location event
  if (event.eventType === "workingLocation") return true;

  return false;
}

// Helper function to normalize email for comparison
function normalizeEmail(email: string): string {
  if (!email) return "";

  const [localPart, domain] = email.toLowerCase().split("@");

  // Treat wingify.com as equivalent to vwo.com
  const normalizedDomain = domain === "wingify.com" ? "vwo.com" : domain;

  return `${localPart}@${normalizedDomain}`;
}

// Helper function to check if two emails match (considering domain aliases and partial matches)
function emailsMatch(email1: string, email2: string): boolean {
  if (!email1 || !email2) return false;

  const normalized1 = normalizeEmail(email1);
  const normalized2 = normalizeEmail(email2);

  // Exact match after normalization
  if (normalized1 === normalized2) return true;

  // Check if one email contains the other (for cases like ankit.jain@vwo.com vs ankit@vwo.com)
  const [local1, domain1] = normalized1.split("@");
  const [local2, domain2] = normalized2.split("@");

  // If domains match, check if local parts are similar
  if (domain1 === domain2) {
    // Check if one local part contains the other
    if (local1.includes(local2) || local2.includes(local1)) {
      return true;
    }

    // Check if they share a common prefix (e.g., "ankit" in both "ankit.jain" and "ankit")
    const local1Parts = local1.split(".");
    const local2Parts = local2.split(".");

    // Check if any part of one local matches any part of the other
    for (const part1 of local1Parts) {
      for (const part2 of local2Parts) {
        if (part1 === part2 && part1.length > 2) {
          // Only match if part is meaningful (more than 2 chars)
          return true;
        }
      }
    }
  }

  return false;
}

// New function to fetch individual meetings from Google Calendar
async function getIndividualGoogleCalendarMeetings(params: {
  credentials: any[];
  selectedCalendars: any[];
  startTime: string;
  endTime: string;
  userId: number;
}) {
  const { credentials, selectedCalendars, startTime, endTime, userId } = params;

  const individualMeetings: any[] = [];
  const seenEvents = new Set<string>(); // Track seen events to avoid duplicates

  // Get Google Calendar credentials
  const googleCalendarCredentials = credentials.filter(
    (cred) => cred.type === "google_calendar" || cred.type === "googlecalendar"
  );

  for (const credential of googleCalendarCredentials) {
    try {
      const calendar = getCalendar(credential);
      if (!calendar) {
        continue;
      }

      // Get selected calendars for this credential
      const credentialSelectedCalendars = selectedCalendars.filter(
        (sc) => sc.integration === credential.type
      );

      if (credentialSelectedCalendars.length === 0) {
        continue;
      }

      // Cast to GoogleCalendarService to access auth property
      const googleCalendarService = calendar as any;
      if (!googleCalendarService.auth) {
        continue;
      }

      // Use Google Calendar API directly to get individual events
      const myGoogleAuth = await googleCalendarService.auth.getToken();

      const googleCalendar = google.calendar({
        version: "v3",
        auth: myGoogleAuth,
      });

      // Get calendar IDs
      const calendarIds = credentialSelectedCalendars.map((sc) => sc.externalId);

      for (const calendarId of calendarIds) {
        try {
          // Use events.list to get individual events instead of freebusy.query
          const response = await googleCalendar.events.list({
            calendarId: calendarId,
            timeMin: startTime,
            timeMax: endTime,
            singleEvents: true, // Expand recurring events
            orderBy: "startTime",
            maxResults: 2500, // Get more events
            showDeleted: false, // Don't show deleted events
          });

          if (response.data.items) {
            for (const event of response.data.items) {
              // Skip location-only events
              if (isLocationOnlyEvent(event)) {
                continue;
              }

              if (event.start && event.end) {
                // Create a unique key for this event to avoid duplicates
                const eventKey = `${event.id}_${event.start.dateTime || event.start.date}_${
                  event.end.dateTime || event.end.date
                }`;

                // Skip if we've already seen this event
                if (seenEvents.has(eventKey)) {
                  continue;
                }

                // Check if the user is the organizer or an accepted attendee
                const userEmail = await getUserEmail(userId);

                // Use the new email matching logic
                const isOrganizer = event.organizer?.email && emailsMatch(event.organizer.email, userEmail);

                const isAcceptedAttendee = event.attendees?.some((attendee: any) => {
                  const attendeeEmail = attendee.email;
                  const isAccepted = attendee.responseStatus === "accepted";
                  const emailMatches = emailsMatch(attendeeEmail, userEmail);

                  return isAccepted && emailMatches;
                });

                // Only include events where user is organizer or accepted attendee
                if (isOrganizer || isAcceptedAttendee) {
                  seenEvents.add(eventKey);
                  individualMeetings.push({
                    start: event.start.dateTime || event.start.date,
                    end: event.end.dateTime || event.end.date,
                    title: event.summary || "Google Calendar Event",
                    description: event.description || "",
                    location: event.location || "",
                    attendees: event.attendees || [],
                    organizer: event.organizer || null,
                    source: `google_calendar_${credential.id}`,
                    calendarId: calendarId,
                    eventId: event.id,
                    credentialId: credential.id,
                    calendarType: credential.type,
                    isOrganizer,
                    isAcceptedAttendee,
                  });
                }
              }
            }
          }
        } catch (error) {
          console.error(`Error fetching events from calendar ${calendarId}:`, error);
        }
      }
    } catch (error) {
      console.error(`Error fetching from Google Calendar credential ${credential.id}:`, error);
    }
  }

  return individualMeetings;
}

// New function to fetch individual Cal.com bookings
async function getIndividualCalBookings(params: { userId: number; startTime: string; endTime: string }) {
  const { userId, startTime, endTime } = params;

  const bookings = await prisma.booking.findMany({
    where: {
      userId,
      startTime: { gte: new Date(startTime) },
      endTime: { lte: new Date(endTime) },
      status: "ACCEPTED", // Only accepted bookings
      showBusy: true,
    },
    select: {
      id: true,
      startTime: true,
      endTime: true,
      title: true,
      eventTypeId: true,
      attendees: {
        select: {
          email: true,
          name: true,
        },
      },
    },
    orderBy: {
      startTime: "asc",
    },
  });

  // Deduplicate bookings based on start time, end time, and title
  const seenBookings = new Set<string>();
  const uniqueBookings = bookings.filter((booking) => {
    const bookingKey = `${booking.startTime}_${booking.endTime}_${booking.title}`;
    if (seenBookings.has(bookingKey)) {
      return false;
    }
    seenBookings.add(bookingKey);
    return true;
  });

  return uniqueBookings.map((booking) => ({
    start: booking.startTime,
    end: booking.endTime,
    title: booking.title,
    source: `cal_booking_${booking.id}`,
    eventTypeId: booking.eventTypeId,
    attendees: booking.attendees,
    isCalBooking: true,
  }));
}

export const adminAvailabilityRouter = createProtectedRouter()
  .query("getAllUsers", {
    async resolve({ ctx }) {
      const { session } = ctx;

      if (session?.user?.role !== "ADMIN") {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const users = await prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          username: true,
          timeZone: true,
          availability: true,
          schedules: {
            select: {
              id: true,
              name: true,
              availability: true,
              timeZone: true,
            },
          },
          defaultScheduleId: true,
          credentials: {
            where: {
              type: "google_calendar",
            },
            select: {
              id: true,
              type: true,
            },
          },
          selectedCalendars: {
            where: {
              integration: "google_calendar",
            },
            select: {
              externalId: true,
              integration: true,
            },
          },
        },
        orderBy: {
          name: "asc",
        },
      });

      return users;
    },
  })
  .query("getUserAvailabilityWithCategories", {
    input: z.object({
      userId: z.number(),
      dateFrom: z.string(),
      dateTo: z.string(),
      includeEventDetails: z.boolean().optional().default(true),
    }),
    async resolve({ ctx, input }) {
      const { session } = ctx;

      if (session?.user?.role !== "ADMIN") {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: input.userId },
        select: {
          ...availabilityUserSelect,
          name: true,
          email: true,
          credentials: {
            where: {
              type: "google_calendar",
            },
          },
          selectedCalendars: {
            where: {
              integration: "google_calendar",
            },
          },
        },
      });

      if (!targetUser) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      // Get basic availability
      const availability = await getUserAvailability({
        userId: input.userId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        withSource: input.includeEventDetails,
      });

      // Get categorized busy times
      const categorizedBusyTimes = await getCategorizedBusyTimes({
        credentials: targetUser.credentials,
        selectedCalendars: targetUser.selectedCalendars,
        startTime: input.dateFrom,
        endTime: input.dateTo,
        userId: input.userId,
      });

      const result = {
        user: {
          id: targetUser.id,
          name: targetUser.name,
          email: targetUser.email,
          username: targetUser.username,
          timeZone: targetUser.timeZone,
        },
        availability,
        categorizedBusyTimes,
      };

      return result;
    },
  })
  .query("getMultiUserAvailability", {
    input: z.object({
      userIds: z.array(z.number()),
      dateFrom: z.string(),
      dateTo: z.string(),
      includeEventDetails: z.boolean().optional().default(true),
    }),
    async resolve({ ctx, input }) {
      const { session } = ctx;

      if (session?.user?.role !== "ADMIN") {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const results = await Promise.all(
        input.userIds.map(async (userId) => {
          try {
            const targetUser = await prisma.user.findUnique({
              where: { id: userId },
              select: {
                ...availabilityUserSelect,
                name: true,
                email: true,
                credentials: {
                  where: {
                    type: "google_calendar",
                  },
                },
                selectedCalendars: {
                  where: {
                    integration: "google_calendar",
                  },
                },
              },
            });

            if (!targetUser) {
              return { userId, error: "User not found" };
            }

            // Convert date range to user's availability schedule timezone for proper analysis
            // Use the same timezone resolution logic as getUserAvailability
            const schedule = targetUser.schedules.filter(
              (schedule) => !targetUser.defaultScheduleId || schedule.id === targetUser.defaultScheduleId
            )[0];
            const userTz = schedule?.timeZone || targetUser.timeZone || "UTC";

            // Parse input dates in user's timezone to avoid UTC conversion issues
            // Frontend now sends YYYY-MM-DD format to preserve date boundaries
            // Use explicit time to avoid timezone interpretation issues
            const startDateInUserTz = dayjs.tz(`${input.dateFrom} 00:00:00`, userTz);
            const endDateInUserTz = dayjs.tz(`${input.dateTo} 23:59:59`, userTz);

            // Convert back to UTC for database queries, but maintain the user timezone boundaries
            const startDateUTC = startDateInUserTz.utc();
            const endDateUTC = endDateInUserTz.utc();

            // Get basic availability
            const availability = await getUserAvailability({
              userId,
              dateFrom: startDateUTC.toISOString(),
              dateTo: endDateUTC.toISOString(),
              withSource: input.includeEventDetails,
            });

            // Get categorized busy times
            const busyTimesResult = await getCategorizedBusyTimes({
              credentials: targetUser.credentials,
              selectedCalendars: targetUser.selectedCalendars,
              startTime: startDateUTC.toISOString(),
              endTime: endDateUTC.toISOString(),
              userId,
            });

            // Use resolved meetings for daily breakdown, merged meetings for overall analytics
            const categorizedBusyTimes = busyTimesResult.mergedMeetings;
            const resolvedBusyTimes = busyTimesResult.resolvedMeetings;

            // Check for any meetings outside expected date range
            if (categorizedBusyTimes.length > 0) {
              const dateIssues = categorizedBusyTimes.filter((meeting) => {
                const meetingDate = dayjs(meeting.start).format("YYYY-MM-DD");
                return meetingDate < input.dateFrom || meetingDate > input.dateTo;
              });
              if (dateIssues.length > 0) {
                // Debug: meetings found outside expected date range
              }
            }

            // Use workingHours from availability instead of raw availability data
            const userWorkingHours = availability.workingHours;

            const analytics = calculateDetailedTimeAnalytics(
              categorizedBusyTimes,
              startDateInUserTz,
              endDateInUserTz,
              userWorkingHours,
              targetUser.timeZone,
              resolvedBusyTimes
            );

            // Track if analytics found any issues
            if (analytics.totalBusyHours === 0 && categorizedBusyTimes.length > 0) {
              // Analytics issue: meetings found but no busy hours calculated
            }

            // Handle single-day views on non-working days
            const startDate = dayjs(input.dateFrom);
            const endDate = dayjs(input.dateTo);
            const isSingleDay = startDate.isSame(endDate, "day");
            const dayOfWeek = startDate.day(); // 0 = Sunday, 1 = Monday, etc.

            if (isSingleDay && analytics.totalWorkingHours === 0 && dayOfWeek === 0) {
              // Get the week containing this Sunday
              const weekStart = startDate.startOf("week").add(1, "day"); // Monday
              const weekEnd = startDate.endOf("week").subtract(1, "day"); // Friday

              // Convert week boundaries to UTC for database query
              const weekStartUTC = weekStart.utc();
              const weekEndUTC = weekEnd.utc();

              // Re-fetch busy times for the week
              const weeklyBusyTimesResult = await getCategorizedBusyTimes({
                credentials: targetUser.credentials,
                selectedCalendars: targetUser.selectedCalendars,
                startTime: weekStartUTC.toISOString(),
                endTime: weekEndUTC.toISOString(),
                userId,
              });

              const weeklyBusyTimes = weeklyBusyTimesResult.mergedMeetings;
              const weeklyResolvedBusyTimes = weeklyBusyTimesResult.resolvedMeetings;

              // Calculate analytics for the week using user timezone boundaries
              const weeklyAnalytics = calculateDetailedTimeAnalytics(
                weeklyBusyTimes,
                weekStart,
                weekEnd,
                userWorkingHours,
                targetUser.timeZone,
                weeklyResolvedBusyTimes
              );

              // Scale the analytics to represent the single day proportion
              const scaleFactor = 1 / 5; // 1 day out of 5 working days
              analytics.totalWorkingHours = weeklyAnalytics.totalWorkingHours * scaleFactor;
              analytics.totalBusyHours = weeklyAnalytics.totalBusyHours * scaleFactor;
              analytics.availabilityOverlap.hours = weeklyAnalytics.availabilityOverlap.hours * scaleFactor;
              analytics.categoryStats = Object.fromEntries(
                Object.entries(weeklyAnalytics.categoryStats).map(([key, stats]) => [
                  key,
                  {
                    ...stats,
                    hours: stats.hours * scaleFactor,
                  },
                ])
              );
            }

            // Processing complete for user

            const responseData = {
              userId,
              user: {
                id: targetUser.id,
                name: targetUser.name,
                email: targetUser.email,
                username: targetUser.username,
                timeZone: targetUser.timeZone,
              },
              availability,
              categorizedBusyTimes,
              analytics,
            };

            return responseData;
          } catch (error) {
            return { userId, error: error instanceof Error ? error.message : "Unknown error" };
          }
        })
      );

      return results;
    },
  })
  .query("getMonthlyAvailabilityReport", {
    input: z.object({
      userIds: z.array(z.number()).optional(),
      year: z.number(),
      month: z.number(),
    }),
    async resolve({ ctx, input }) {
      const { session } = ctx;

      if (session?.user?.role !== "ADMIN") {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const startDate = dayjs()
        .year(input.year)
        .month(input.month - 1)
        .startOf("month");
      const endDate = startDate.endOf("month");

      // Get all users if no specific users provided
      const userIds =
        input.userIds ||
        (
          await prisma.user.findMany({
            select: { id: true },
            orderBy: { name: "asc" },
          })
        ).map((u) => u.id);

      const results = await Promise.all(
        userIds.map(async (userId) => {
          try {
            const targetUser = await prisma.user.findUnique({
              where: { id: userId },
              select: {
                ...availabilityUserSelect,
                name: true,
                email: true,
                credentials: {
                  where: {
                    type: "google_calendar",
                  },
                },
                selectedCalendars: {
                  where: {
                    integration: "google_calendar",
                  },
                },
              },
            });

            if (!targetUser) {
              return { userId, error: "User not found" };
            }

            // Convert date range to user's availability schedule timezone for proper analysis
            // Use the same timezone resolution logic as getUserAvailability
            const schedule = targetUser.schedules.filter(
              (schedule) => !targetUser.defaultScheduleId || schedule.id === targetUser.defaultScheduleId
            )[0];
            const userTz = schedule?.timeZone || targetUser.timeZone || "UTC";

            // Parse month boundaries in user timezone
            // Use explicit time to avoid timezone interpretation issues
            const startDateInUserTz = dayjs.tz(`${startDate.format("YYYY-MM-DD")} 00:00:00`, userTz);
            const endDateInUserTz = dayjs.tz(`${endDate.format("YYYY-MM-DD")} 23:59:59`, userTz);

            // Convert back to UTC for database queries, maintaining user timezone boundaries
            const startDateUTC = startDateInUserTz.utc();
            const endDateUTC = endDateInUserTz.utc();

            // Get monthly availability
            const availability = await getUserAvailability({
              userId,
              dateFrom: startDateUTC.toISOString(),
              dateTo: endDateUTC.toISOString(),
              withSource: true,
            });

            // Get categorized busy times for the month
            const busyTimesResult = await getCategorizedBusyTimes({
              credentials: targetUser.credentials,
              selectedCalendars: targetUser.selectedCalendars,
              startTime: startDateUTC.toISOString(),
              endTime: endDateUTC.toISOString(),
              userId,
            });

            const categorizedBusyTimes = busyTimesResult.mergedMeetings;
            const resolvedBusyTimes = busyTimesResult.resolvedMeetings;

            // Calculate detailed statistics using timezone-adjusted dates
            const userWorkingHours = availability.workingHours;
            const stats = calculateDetailedTimeAnalytics(
              categorizedBusyTimes,
              startDateInUserTz,
              endDateInUserTz,
              userWorkingHours,
              targetUser.timeZone,
              resolvedBusyTimes
            );

            return {
              userId,
              user: {
                id: targetUser.id,
                name: targetUser.name,
                email: targetUser.email,
                username: targetUser.username,
                timeZone: targetUser.timeZone,
              },
              availability,
              categorizedBusyTimes,
              monthlyStats: stats,
            };
          } catch (error) {
            return { userId, error: error instanceof Error ? error.message : "Unknown error" };
          }
        })
      );

      return {
        month: input.month,
        year: input.year,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        results,
      };
    },
  })
  .query("getDetailedAnalytics", {
    input: z.object({
      userIds: z.array(z.number()),
      dateFrom: z.string(),
      dateTo: z.string(),
      includeAvailabilityOverlap: z.boolean().optional().default(true),
    }),
    async resolve({ ctx, input }) {
      const { session } = ctx;

      if (session?.user?.role !== "ADMIN") {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const allUsersData = [];

      for (const userId of input.userIds) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            name: true,
            email: true,
            username: true,
            timeZone: true,
            availability: true,
            schedules: {
              select: {
                id: true,
                name: true,
                availability: true,
                timeZone: true,
              },
            },
            defaultScheduleId: true,
            credentials: {
              where: {
                type: "google_calendar",
              },
              select: {
                id: true,
                type: true,
              },
            },
            selectedCalendars: {
              where: {
                integration: "google_calendar",
              },
              select: {
                externalId: true,
                integration: true,
              },
            },
          },
        });

        if (!user) continue;

        // Convert date range to user's availability schedule timezone for proper analysis
        // Use the same timezone resolution logic as getUserAvailability
        const schedule = user.schedules.filter(
          (schedule) => !user.defaultScheduleId || schedule.id === user.defaultScheduleId
        )[0];
        const userTz = schedule?.timeZone || user.timeZone || "UTC";

        // Parse input dates in user timezone to avoid UTC conversion issues
        // Frontend now sends YYYY-MM-DD format to preserve date boundaries
        // Use explicit time to avoid timezone interpretation issues
        const startDateInUserTz = dayjs.tz(`${input.dateFrom} 00:00:00`, userTz);
        const endDateInUserTz = dayjs.tz(`${input.dateTo} 23:59:59`, userTz);

        // Convert back to UTC for database queries, maintaining user timezone boundaries
        const startDateUTC = startDateInUserTz.utc();
        const endDateUTC = endDateInUserTz.utc();

        // Get user availability with working hours
        const availability = await getUserAvailability({
          userId: user.id,
          dateFrom: startDateUTC.toISOString(),
          dateTo: endDateUTC.toISOString(),
          withSource: false,
        });

        const busyTimesResult = await getCategorizedBusyTimes({
          credentials: user.credentials,
          selectedCalendars: user.selectedCalendars,
          startTime: startDateUTC.toISOString(),
          endTime: endDateUTC.toISOString(),
          userId: user.id,
        });

        // Use resolved meetings for daily breakdown, merged meetings for overall analytics
        const categorizedBusyTimes = busyTimesResult.mergedMeetings;
        const resolvedBusyTimes = busyTimesResult.resolvedMeetings;

        // Use working hours from availability
        const userWorkingHours = input.includeAvailabilityOverlap ? availability.workingHours : undefined;

        const detailedStats = calculateDetailedTimeAnalytics(
          categorizedBusyTimes,
          startDateInUserTz,
          endDateInUserTz,
          userWorkingHours,
          user.timeZone,
          resolvedBusyTimes
        );

        const dailyBreakdown = calculateDailyBreakdown(
          resolvedBusyTimes,
          startDateInUserTz,
          endDateInUserTz,
          user.timeZone
        );
        const weeklyBreakdown = calculateWeeklyBreakdown(
          categorizedBusyTimes,
          startDateInUserTz,
          endDateInUserTz,
          user.timeZone
        );
        const monthlyBreakdown = calculateMonthlyBreakdown(
          categorizedBusyTimes,
          startDateInUserTz,
          endDateInUserTz,
          user.timeZone
        );

        allUsersData.push({
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            username: user.username,
            timeZone: user.timeZone,
          },
          detailedStats,
          dailyBreakdown,
          weeklyBreakdown,
          monthlyBreakdown,
          categorizedBusyTimes,
        });
      }

      return {
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        users: allUsersData,
      };
    },
  });

// Helper function to get categorized busy times
async function getCategorizedBusyTimes(params: {
  credentials: any[];
  selectedCalendars: any[];
  startTime: string;
  endTime: string;
  userId: number;
}) {
  const { credentials, selectedCalendars, startTime, endTime, userId } = params;

  // Get individual Google Calendar meetings
  const googleCalendarMeetings = await getIndividualGoogleCalendarMeetings({
    credentials,
    selectedCalendars,
    startTime,
    endTime,
    userId,
  });

  // Get individual Cal.com bookings
  const calBookings = await getIndividualCalBookings({
    userId,
    startTime,
    endTime,
  });

  // Combine all individual meetings
  const allMeetings = [...googleCalendarMeetings, ...calBookings];

  // Filter out meetings outside the requested date range
  const startDate = dayjs(startTime);
  const endDate = dayjs(endTime);

  const filteredMeetings = allMeetings.filter((meeting) => {
    const meetingStart = dayjs(meeting.start);
    const meetingEnd = dayjs(meeting.end);

    // Meeting must start before end date and end after start date to be included
    const isInRange = meetingStart.isBefore(endDate) && meetingEnd.isAfter(startDate);

    if (!isInRange) {
      const meetingDateStr = meetingStart.format("YYYY-MM-DD");
    }

    return isInRange;
  });

  // Categorize each individual meeting
  const categorizedMeetings: any[] = [];

  for (const meeting of filteredMeetings) {
    const category = await categorizeBusyTime(meeting, credentials, userId);

    categorizedMeetings.push({
      ...meeting,
      category,
      eventTitle: meeting.title || "Calendar Event",
      source: meeting.source,
      start: meeting.start,
      end: meeting.end,
    });
  }

  // Resolve overlapping meetings
  const resolvedMeetings = resolveOverlappingMeetings(categorizedMeetings);

  // Calculate time difference
  const originalTotalHours = categorizedMeetings.reduce((sum, m) => {
    return sum + dayjs(m.end).diff(dayjs(m.start), "hour", true);
  }, 0);

  // Calculate resolved hours by merging overlapping segments
  const mergedRanges: Array<{ start: dayjs.Dayjs; end: dayjs.Dayjs; category: string }> = [];

  // Sort resolved meetings by start time
  const sortedResolved = resolvedMeetings.sort((a, b) => dayjs(a.start).diff(dayjs(b.start)));

  for (const meeting of sortedResolved) {
    const meetingStart = dayjs(meeting.start);
    const meetingEnd = dayjs(meeting.end);
    const meetingCategory = meeting.category || "unknown";

    // Find overlapping ranges in mergedRanges
    const overlappingRanges = mergedRanges.filter(
      (range) => meetingStart.isBefore(range.end) && meetingEnd.isAfter(range.start)
    );

    if (overlappingRanges.length === 0) {
      // No overlap, add as new range
      mergedRanges.push({
        start: meetingStart,
        end: meetingEnd,
        category: meetingCategory,
      });
    } else {
      // Merge with overlapping ranges
      let mergedStart = meetingStart;
      let mergedEnd = meetingEnd;

      for (const range of overlappingRanges) {
        mergedStart = mergedStart.isBefore(range.start) ? mergedStart : range.start;
        mergedEnd = mergedEnd.isAfter(range.end) ? mergedEnd : range.end;
      }

      // Remove overlapping ranges and add merged range
      const nonOverlappingRanges = mergedRanges.filter(
        (range) => !(meetingStart.isBefore(range.end) && meetingEnd.isAfter(range.start))
      );

      nonOverlappingRanges.push({
        start: mergedStart,
        end: mergedEnd,
        category: meetingCategory,
      });

      mergedRanges.splice(0, mergedRanges.length, ...nonOverlappingRanges);
    }
  }

  const resolvedTotalHours = mergedRanges.reduce((total, range) => {
    return total + range.end.diff(range.start, "hour", true);
  }, 0);

  const timeDifference = originalTotalHours - resolvedTotalHours;

  // Convert merged ranges back to meeting format for frontend compatibility
  // For analytics, we want to preserve original meeting information
  const mergedMeetings = mergedRanges.map((range, index) => {
    // Find the original meetings that contributed to this merged range
    const contributingMeetings = categorizedMeetings.filter((meeting) => {
      const meetingStart = dayjs(meeting.start);
      const meetingEnd = dayjs(meeting.end);
      return meetingStart.isBefore(range.end) && meetingEnd.isAfter(range.start);
    });

    // Use the title of the first contributing meeting, or fallback to merged title
    const title =
      contributingMeetings.length > 0 ? contributingMeetings[0].title : `Merged Meeting ${index + 1}`;

    return {
      id: `merged-${index}`,
      title: title,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      category: range.category,
      source: "merged",
      // Preserve original meeting info for analytics
      originalMeetings: contributingMeetings,
    };
  });

  return {
    resolvedMeetings, // Individual split meetings for daily breakdown
    mergedMeetings, // Merged ranges for overall analytics
  };
}

// Helper function to check if an email is from internal domain
function isInternalEmail(email: string): boolean {
  if (!email) return false;
  const domain = email.toLowerCase().split("@")[1];
  return domain === "vwo.com" || domain === "wingify.com";
}

// Helper function to categorize busy time
async function categorizeBusyTime(meeting: any, credentials: any[], userId: number) {
  // If it's from Cal.com bookings
  if (meeting.isCalBooking || meeting.source?.includes("cal_booking_")) {
    return "external_meeting";
  }

  // If it's from Google Calendar
  if (meeting.source?.includes("google_calendar_")) {
    // Check if it's a Google Calendar event
    if (meeting.title) {
      // Check for self-blocked: organized by user with no other attendees
      const userEmail = await getUserEmail(userId);
      const isOrganizedByUser = meeting.organizer?.email && emailsMatch(meeting.organizer.email, userEmail);
      const hasNoOtherAttendees = !meeting.attendees || meeting.attendees.length === 0;

      if (isOrganizedByUser && hasNoOtherAttendees) {
        return "self_blocked";
      }

      // Check if all participants are from internal domains
      const allEmails = [];

      // Add organizer email
      if (meeting.organizer?.email) {
        allEmails.push(meeting.organizer.email);
      }

      // Add attendee emails
      if (meeting.attendees && Array.isArray(meeting.attendees)) {
        meeting.attendees.forEach((attendee: any) => {
          if (attendee.email) {
            allEmails.push(attendee.email);
          }
        });
      }

      // Check if all emails are from internal domains
      const allInternal = allEmails.length > 0 && allEmails.every((email) => isInternalEmail(email));

      if (allInternal) {
        return "internal_meeting";
      }

      // Default for Google Calendar events is external meeting
      return "external_meeting";
    }

    // If no title, default to external meeting for Google Calendar
    return "external_meeting";
  }

  // Check for other calendar sources
  if (meeting.source) {
    // Check for self-blocked: organized by user with no other attendees
    const userEmail = await getUserEmail(userId);
    const isOrganizedByUser = meeting.organizer?.email && emailsMatch(meeting.organizer.email, userEmail);
    const hasNoOtherAttendees = !meeting.attendees || meeting.attendees.length === 0;

    if (isOrganizedByUser && hasNoOtherAttendees) {
      return "self_blocked";
    }

    // Check if all participants are from internal domains
    if (meeting.title) {
      const allEmails = [];

      // Add organizer email
      if (meeting.organizer?.email) {
        allEmails.push(meeting.organizer.email);
      }

      // Add attendee emails
      if (meeting.attendees && Array.isArray(meeting.attendees)) {
        meeting.attendees.forEach((attendee: any) => {
          if (attendee.email) {
            allEmails.push(attendee.email);
          }
        });
      }

      // Check if all emails are from internal domains
      const allInternal = allEmails.length > 0 && allEmails.every((email) => isInternalEmail(email));

      if (allInternal) {
        return "internal_meeting";
      }
    }

    // Default for other calendar sources
    return "external_meeting";
  }

  // Default categorization
  return "unknown";
}

// Enhanced analytics functions for detailed reporting

// Helper function to calculate detailed time analytics
function calculateDetailedTimeAnalytics(
  categorizedBusyTimes: any[],
  startDate: dayjs.Dayjs,
  endDate: dayjs.Dayjs,
  userAvailability?: any,
  userTimeZone?: string,
  resolvedBusyTimes?: any[]
) {
  const totalDays = endDate.diff(startDate, "day") + 1;

  // Initialize category statistics with detailed breakdown
  const categoryStats: Record<
    string,
    {
      count: number;
      hours: number;
      percentage: number;
      hoursInWorkingTime: number;
      hoursOutsideWorkingTime: number;
    }
  > = {
    external_meeting: {
      count: 0,
      hours: 0,
      percentage: 0,
      hoursInWorkingTime: 0,
      hoursOutsideWorkingTime: 0,
    },
    internal_meeting: {
      count: 0,
      hours: 0,
      percentage: 0,
      hoursInWorkingTime: 0,
      hoursOutsideWorkingTime: 0,
    },
    self_blocked: { count: 0, hours: 0, percentage: 0, hoursInWorkingTime: 0, hoursOutsideWorkingTime: 0 },
    unknown: { count: 0, hours: 0, percentage: 0, hoursInWorkingTime: 0, hoursOutsideWorkingTime: 0 },
  };

  // Calculate working hours based on availability
  let totalWorkingHours = 0;
  let busyTimeInWorkingHours = 0;
  let busyTimeOutsideWorkingHours = 0;
  let availabilityOverlap = { hours: 0, percentage: 0 };
  const meetingsOutsideWorkingHours: any[] = [];
  let availableTimeForExternalMeetings = 0;

  // Process userAvailability - this should be WorkingHours[] from getWorkingHours
  if (userAvailability && Array.isArray(userAvailability)) {
    // Calculate total working hours for the date range
    let currentDate = startDate.clone();
    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate, "day")) {
      const dayOfWeek = currentDate.day();

      // Find availability slots for this day of the week
      const dayAvailability = userAvailability.filter(
        (slot: any) => slot.days && slot.days.includes(dayOfWeek)
      );

      for (const slot of dayAvailability) {
        const startMinutes = slot.startTime;
        const endMinutes = slot.endTime;
        const duration = (endMinutes - startMinutes) / 60;
        totalWorkingHours += duration;
      }

      currentDate = currentDate.add(1, "day");
    }
  }

  // Process each busy time
  categorizedBusyTimes.forEach((busyTime) => {
    const category = busyTime.category || "unknown";
    const start = dayjs(busyTime.start);
    const end = dayjs(busyTime.end);
    const duration = end.diff(start, "hour", true);

    categoryStats[category].count++;
    categoryStats[category].hours += duration;

    // Check if this time overlaps with working hours and calculate partial overlap
    if (userAvailability && Array.isArray(userAvailability)) {
      // Convert busy time to user's timezone for proper comparison
      const busyTimeInUserTz = userTimeZone ? start.tz(userTimeZone) : start;
      const busyTimeEndInUserTz = userTimeZone ? end.tz(userTimeZone) : end;
      const dayOfWeek = busyTimeInUserTz.day();

      // Convert to minutes since midnight for comparison
      const busyStartMinutes = busyTimeInUserTz.hour() * 60 + busyTimeInUserTz.minute();
      const busyEndMinutes = busyTimeEndInUserTz.hour() * 60 + busyTimeEndInUserTz.minute();

      let totalOverlapHours = 0;

      // Calculate overlap with each working time slot
      for (const slot of userAvailability) {
        if (slot.days && slot.days.includes(dayOfWeek)) {
          const slotStartMinutes = slot.startTime;
          const slotEndMinutes = slot.endTime;

          // Check for overlap: busy time must overlap with working hours
          const hasOverlap = busyStartMinutes < slotEndMinutes && busyEndMinutes > slotStartMinutes;

          if (hasOverlap) {
            // Calculate the exact overlap duration
            const overlapStartMinutes = Math.max(busyStartMinutes, slotStartMinutes);
            const overlapEndMinutes = Math.min(busyEndMinutes, slotEndMinutes);
            const overlapDurationMinutes = overlapEndMinutes - overlapStartMinutes;
            const overlapHours = overlapDurationMinutes / 60;

            totalOverlapHours += overlapHours;
          }
        }
      }

      // Add the calculated overlap to busyTimeInWorkingHours
      if (totalOverlapHours > 0) {
        busyTimeInWorkingHours += totalOverlapHours;
        categoryStats[category].hoursInWorkingTime += totalOverlapHours;
      }

      // Calculate time outside working hours
      const timeOutsideWorkingHours = duration - totalOverlapHours;
      if (timeOutsideWorkingHours > 0) {
        // Only count non-self-blocked time as concerning "busy time outside working hours"
        // Self-blocking outside work hours is normal and expected
        if (category !== "self_blocked") {
          busyTimeOutsideWorkingHours += timeOutsideWorkingHours;
        }
        categoryStats[category].hoursOutsideWorkingTime += timeOutsideWorkingHours;

        // Only add to meetingsOutsideWorkingHours if there's significant time outside (> 5 minutes)
        // and it's not self-blocked time (personal time blocking is normal)
        if (timeOutsideWorkingHours > 0.083 && category !== "self_blocked") {
          // 0.083 hours = 5 minutes
          const meetingTitle =
            busyTime.originalMeetings && busyTime.originalMeetings.length > 0
              ? busyTime.originalMeetings[0].title
              : busyTime.title || "Unknown";

          meetingsOutsideWorkingHours.push({
            title: meetingTitle,
            start: busyTime.start,
            end: busyTime.end,
            category: busyTime.category,
            duration: timeOutsideWorkingHours, // Use the calculated outside duration
            dayOfWeek: dayOfWeek,
            timeOfDay: busyStartMinutes,
            userTimeZone: userTimeZone,
            totalDuration: duration,
            overlapWithWorkingHours: totalOverlapHours,
          });
        }
      }
    }
  });

  // Calculate percentages
  Object.keys(categoryStats).forEach((category) => {
    categoryStats[category].percentage =
      totalWorkingHours > 0 ? (categoryStats[category].hoursInWorkingTime / totalWorkingHours) * 100 : 0;
  });

  // Calculate availability overlap
  if (totalWorkingHours > 0) {
    availabilityOverlap = {
      hours: busyTimeInWorkingHours,
      percentage: (busyTimeInWorkingHours / totalWorkingHours) * 100,
    };

    // Calculate available time for external meetings
    // This should only subtract meetings that occur DURING working hours
    // Meetings outside working hours shouldn't reduce available time during working hours
    availableTimeForExternalMeetings = Math.max(0, totalWorkingHours - busyTimeInWorkingHours);

    const totalBusyTime = Object.values(categoryStats).reduce((sum, stat) => sum + stat.hours, 0);
  }

  const totalBusyHours = Object.values(categoryStats).reduce((sum, stat) => sum + stat.hours, 0);

  // For single day views, try to calculate working hours for that specific day if needed
  if (totalWorkingHours === 0 && totalDays === 1 && userAvailability && Array.isArray(userAvailability)) {
    const specificDay = startDate.day();

    userAvailability.forEach((slot: any) => {
      if (slot.days && slot.days.includes(specificDay)) {
        const duration = (slot.endTime - slot.startTime) / 60;
        totalWorkingHours += duration;
      }
    });
  }

  // Calculate sales-focused analytics
  // Use resolved meetings for daily breakdown, or fall back to merged meetings
  const busyTimesForDailyBreakdown = resolvedBusyTimes || categorizedBusyTimes;
  const salesAnalytics = calculateSalesAnalytics(
    busyTimesForDailyBreakdown,
    startDate,
    endDate,
    userAvailability,
    totalWorkingHours,
    categoryStats,
    userTimeZone,
    availableTimeForExternalMeetings
  );

  return {
    totalDays,
    totalHours: totalDays * 24,
    totalWorkingHours,
    categoryStats,
    totalBusyHours,
    availabilityOverlap,
    busyTimeOutsideWorkingHours,
    meetingsOutsideWorkingHours,
    availableTimeForExternalMeetings,
    availabilityPercentage:
      totalWorkingHours > 0 ? ((totalWorkingHours - busyTimeInWorkingHours) / totalWorkingHours) * 100 : 0,
    salesAnalytics,
  };
}

// Helper function to calculate sales-focused analytics
function calculateSalesAnalytics(
  categorizedBusyTimes: any[],
  startDate: dayjs.Dayjs,
  endDate: dayjs.Dayjs,
  userAvailability?: any,
  totalWorkingHours?: number,
  categoryStats?: any,
  userTimeZone?: string,
  availableTimeForExternalMeetings?: number
) {
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Calculate daily availability breakdown
  const dailyAvailability: Record<
    string,
    {
      day: string;
      date: string;
      workingHours: number;
      busyHours: number;
      busyHoursInWorkingTime: number;
      busyHoursOutsideWorkingTime: number;
      availableHours: number;
      availabilityPercentage: number;
      externalMeetings: number;
      internalMeetings: number;
      selfBlocked: number;
      externalHours: number;
      internalHours: number;
      selfBlockedHours: number;
      externalHoursInWorkingTime: number;
      externalHoursOutsideWorkingTime: number;
      internalHoursInWorkingTime: number;
      internalHoursOutsideWorkingTime: number;
      selfBlockedHoursInWorkingTime: number;
      selfBlockedHoursOutsideWorkingTime: number;
    }
  > = {};

  // Dates are already in user timezone from calculateDetailedTimeAnalytics, no need to convert again
  const startDateInUserTz = startDate;
  const endDateInUserTz = endDate;

  let currentDate = startDateInUserTz.clone().startOf("day");
  while (currentDate.isBefore(endDateInUserTz) || currentDate.isSame(endDateInUserTz, "day")) {
    const dayOfWeek = currentDate.day();
    const dateKey = currentDate.format("YYYY-MM-DD");

    // Calculate working hours for this day
    let dayWorkingHours = 0;
    if (userAvailability && Array.isArray(userAvailability)) {
      const daySlots = userAvailability.filter((slot: any) => slot.days && slot.days.includes(dayOfWeek));

      for (const slot of daySlots) {
        const duration = (slot.endTime - slot.startTime) / 60; // convert to hours
        dayWorkingHours += duration;
      }
    }

    dailyAvailability[dateKey] = {
      day: dayNames[dayOfWeek],
      date: dateKey,
      workingHours: dayWorkingHours,
      busyHours: 0,
      busyHoursInWorkingTime: 0,
      busyHoursOutsideWorkingTime: 0,
      availableHours: dayWorkingHours,
      availabilityPercentage: 100,
      externalMeetings: 0,
      internalMeetings: 0,
      selfBlocked: 0,
      externalHours: 0,
      internalHours: 0,
      selfBlockedHours: 0,
      externalHoursInWorkingTime: 0,
      externalHoursOutsideWorkingTime: 0,
      internalHoursInWorkingTime: 0,
      internalHoursOutsideWorkingTime: 0,
      selfBlockedHoursInWorkingTime: 0,
      selfBlockedHoursOutsideWorkingTime: 0,
    };

    currentDate = currentDate.add(1, "day");
  }

  // Process busy times per day with consistent timezone handling
  categorizedBusyTimes.forEach((busyTime) => {
    const start = dayjs(busyTime.start);
    const end = dayjs(busyTime.end);

    // Convert to user's timezone for proper daily classification
    const startInUserTz = userTimeZone ? start.tz(userTimeZone) : start;
    const endInUserTz = userTimeZone ? end.tz(userTimeZone) : end;

    // Get the date this meeting starts on (in user timezone)
    const meetingStartDate = startInUserTz.clone().startOf("day");
    const meetingEndDate = endInUserTz.clone().startOf("day");

    // Skip meetings outside our date range
    if (meetingStartDate.isBefore(startDateInUserTz) || meetingEndDate.isAfter(endDateInUserTz)) {
      return;
    }

    // Handle meetings that span multiple days in user timezone
    let currentMeetingDate = meetingStartDate.clone();

    // Distribute meeting hours across days it spans
    while (currentMeetingDate.isBefore(meetingEndDate) || currentMeetingDate.isSame(meetingEndDate, "day")) {
      const dateKey = currentMeetingDate.format("YYYY-MM-DD");

      // Only process dates that exist in our dailyAvailability
      if (!dailyAvailability[dateKey]) {
        currentMeetingDate = currentMeetingDate.add(1, "day");
        continue;
      }

      // Calculate portion of meeting that falls on this day
      const dayStart = currentMeetingDate.clone().startOf("day");
      const dayEnd = currentMeetingDate.clone().endOf("day");

      // Get the actual meeting time boundaries for this day
      const meetingStartOnDay = startInUserTz.isAfter(dayStart) ? startInUserTz : dayStart;
      const meetingEndOnDay = endInUserTz.isBefore(dayEnd) ? endInUserTz : dayEnd;

      // Only process if the meeting actually overlaps with this day
      if (meetingStartOnDay.isBefore(dayEnd) && meetingEndOnDay.isAfter(dayStart)) {
        const durationOnDay = meetingEndOnDay.diff(meetingStartOnDay, "hour", true);

        if (durationOnDay > 0) {
          dailyAvailability[dateKey].busyHours += durationOnDay;

          // Calculate overlap with working hours for this specific day
          const dayOfWeek = currentMeetingDate.day();
          let totalOverlapHours = 0;

          if (userAvailability && Array.isArray(userAvailability)) {
            // Convert meeting time to minutes since midnight for comparison
            const meetingStartMinutes = meetingStartOnDay.hour() * 60 + meetingStartOnDay.minute();
            const meetingEndMinutes = meetingEndOnDay.hour() * 60 + meetingEndOnDay.minute();

            // Calculate overlap with each working time slot for this day
            for (const slot of userAvailability) {
              if (slot.days && slot.days.includes(dayOfWeek)) {
                const slotStartMinutes = slot.startTime;
                const slotEndMinutes = slot.endTime;

                // Check for overlap
                const hasOverlap =
                  meetingStartMinutes < slotEndMinutes && meetingEndMinutes > slotStartMinutes;

                if (hasOverlap) {
                  // Calculate the exact overlap duration
                  const overlapStartMinutes = Math.max(meetingStartMinutes, slotStartMinutes);
                  const overlapEndMinutes = Math.min(meetingEndMinutes, slotEndMinutes);
                  const overlapDurationMinutes = overlapEndMinutes - overlapStartMinutes;
                  const overlapHours = overlapDurationMinutes / 60;

                  totalOverlapHours += overlapHours;
                }
              }
            }
          }

          // Calculate time inside vs outside working hours
          const timeInWorkingHours = Math.min(totalOverlapHours, durationOnDay);
          const timeOutsideWorkingHours = durationOnDay - timeInWorkingHours;

          dailyAvailability[dateKey].busyHoursInWorkingTime += timeInWorkingHours;
          // Only count non-self-blocked time in daily outside working hours
          // Self-blocking outside work hours is normal and expected
          if (busyTime.category !== "self_blocked") {
            dailyAvailability[dateKey].busyHoursOutsideWorkingTime += timeOutsideWorkingHours;
          }

          // Track hours by category for this day (total)
          switch (busyTime.category) {
            case "external_meeting":
              dailyAvailability[dateKey].externalHours += durationOnDay;
              dailyAvailability[dateKey].externalHoursInWorkingTime += timeInWorkingHours;
              dailyAvailability[dateKey].externalHoursOutsideWorkingTime += timeOutsideWorkingHours;
              break;
            case "internal_meeting":
              dailyAvailability[dateKey].internalHours += durationOnDay;
              dailyAvailability[dateKey].internalHoursInWorkingTime += timeInWorkingHours;
              dailyAvailability[dateKey].internalHoursOutsideWorkingTime += timeOutsideWorkingHours;
              break;
            case "self_blocked":
              dailyAvailability[dateKey].selfBlockedHours += durationOnDay;
              dailyAvailability[dateKey].selfBlockedHoursInWorkingTime += timeInWorkingHours;
              dailyAvailability[dateKey].selfBlockedHoursOutsideWorkingTime += timeOutsideWorkingHours;
              break;
          }

          // Count meetings by category (only count once, on the start day)
          if (currentMeetingDate.isSame(meetingStartDate, "day")) {
            switch (busyTime.category) {
              case "external_meeting":
                dailyAvailability[dateKey].externalMeetings++;
                break;
              case "internal_meeting":
                dailyAvailability[dateKey].internalMeetings++;
                break;
              case "self_blocked":
                dailyAvailability[dateKey].selfBlocked++;
                break;
            }
          }
        }
      }

      currentMeetingDate = currentMeetingDate.add(1, "day");
    }
  });

  // Calculate final daily metrics
  Object.keys(dailyAvailability).forEach((dateKey) => {
    const day = dailyAvailability[dateKey];
    day.availableHours = Math.max(0, day.workingHours - day.busyHoursInWorkingTime);
    day.availabilityPercentage = day.workingHours > 0 ? (day.availableHours / day.workingHours) * 100 : 0;
  });

  // Calculate health score and indicators
  // Use the already calculated availableTimeForExternalMeetings for consistency
  const availableTime = availableTimeForExternalMeetings || 0;
  const alreadyBookedExternalTime = categoryStats?.external_meeting?.hoursInWorkingTime || 0;
  const totalExternalCapacity = availableTime + alreadyBookedExternalTime;

  const availabilityPercentage =
    totalWorkingHours && totalWorkingHours > 0 ? (totalExternalCapacity / totalWorkingHours) * 100 : 0;

  const healthStatus =
    availabilityPercentage >= 50 ? "healthy" : availabilityPercentage >= 30 ? "warning" : "critical";
  const healthColor = healthStatus === "healthy" ? "🟢" : healthStatus === "warning" ? "🟡" : "🔴";

  // Calculate blocking behavior score
  const selfBlockPercentage = categoryStats?.self_blocked?.percentage || 0;
  const internalMeetingPercentage = categoryStats?.internal_meeting?.percentage || 0;

  // Risk factors (higher = worse)
  const highSelfBlocking = selfBlockPercentage > 15; // Above 15% threshold
  const highInternalMeetings = internalMeetingPercentage > 35; // Above 35% threshold

  // Calculate blocking behavior score (0-100, lower is more concerning)
  let blockingScore = 100;
  if (selfBlockPercentage > 25) blockingScore -= 40;
  else if (selfBlockPercentage > 15) blockingScore -= 20;

  if (internalMeetingPercentage > 45) blockingScore -= 30;
  else if (internalMeetingPercentage > 35) blockingScore -= 15;

  if (availabilityPercentage < 30) blockingScore -= 20;
  else if (availabilityPercentage < 50) blockingScore -= 10;

  blockingScore = Math.max(0, blockingScore);

  // Detect patterns and red flags with more meaningful analysis
  const redFlags: string[] = [];

  if (selfBlockPercentage > 25) {
    redFlags.push(`⚠️ Very high self-blocking: ${selfBlockPercentage.toFixed(1)}% (threshold: 15%)`);
  } else if (selfBlockPercentage > 15) {
    redFlags.push(`⚠️ High self-blocking: ${selfBlockPercentage.toFixed(1)}% (threshold: 15%)`);
  }

  if (internalMeetingPercentage > 45) {
    redFlags.push(
      `⚠️ Excessive internal meetings: ${internalMeetingPercentage.toFixed(1)}% (threshold: 35%)`
    );
  } else if (internalMeetingPercentage > 35) {
    redFlags.push(`⚠️ High internal meetings: ${internalMeetingPercentage.toFixed(1)}% (threshold: 35%)`);
  }

  if (availabilityPercentage < 30) {
    redFlags.push(`⚠️ Critical availability: ${availabilityPercentage.toFixed(1)}% (target: 50%+)`);
  } else if (availabilityPercentage < 50) {
    redFlags.push(`⚠️ Low availability: ${availabilityPercentage.toFixed(1)}% (target: 50%+)`);
  }

  // Analyze patterns instead of listing individual days
  const workingDays = Object.values(dailyAvailability).filter((day) => day.workingHours > 0);
  const lowAvailabilityDays = workingDays.filter((day) => day.availabilityPercentage < 40);
  const averageAvailability =
    workingDays.length > 0
      ? workingDays.reduce((sum, day) => sum + day.availabilityPercentage, 0) / workingDays.length
      : 0;

  if (lowAvailabilityDays.length > workingDays.length * 0.5) {
    redFlags.push(
      `⚠️ Consistently low availability: ${Math.round(
        (lowAvailabilityDays.length / workingDays.length) * 100
      )}% of days below 40%`
    );
  } else if (lowAvailabilityDays.length >= 3) {
    redFlags.push(`⚠️ Multiple low availability days: ${lowAvailabilityDays.length} days below 40%`);
  }

  // Check for concerning patterns
  const externalAfterHours = categoryStats?.external_meeting?.hoursOutsideWorkingTime || 0;
  const internalAfterHours = categoryStats?.internal_meeting?.hoursOutsideWorkingTime || 0;

  if (externalAfterHours > 5) {
    redFlags.push(
      `⚠️ Significant after-hours client work: ${Math.round(externalAfterHours)}h outside work time`
    );
  }

  if (internalAfterHours > 8) {
    redFlags.push(
      `⚠️ Excessive after-hours internal meetings: ${Math.round(internalAfterHours)}h outside work time`
    );
  }

  // Calculate external call capacity
  // Use the passed availableTimeForExternalMeetings for consistency
  const totalAvailableHours =
    availableTime || Object.values(dailyAvailability).reduce((sum, day) => sum + day.availableHours, 0);

  const averageCallDuration = 0.75; // 45 minutes average
  const potentialExternalCalls = Math.floor(totalAvailableHours / averageCallDuration);

  // Current external utilization rate
  const externalHours = categoryStats?.external_meeting?.hours || 0;
  const utilizationRate = totalAvailableHours > 0 ? (externalHours / totalAvailableHours) * 100 : 0;

  // Find peak and worst availability days
  const sortedDays = Object.values(dailyAvailability)
    .filter((day) => day.workingHours > 0)
    .sort((a, b) => b.availabilityPercentage - a.availabilityPercentage);

  const bestDay = sortedDays[0];
  const worstDay = sortedDays[sortedDays.length - 1];

  // Generate meaningful insights instead of repeating basic stats
  const insights: string[] = [];

  // Availability trends and patterns
  if (averageAvailability > 0) {
    if (averageAvailability >= 70) {
      insights.push(
        `Excellent availability: ${averageAvailability.toFixed(0)}% average across ${
          workingDays.length
        } working days`
      );
    } else if (averageAvailability >= 50) {
      insights.push(`Good availability: ${averageAvailability.toFixed(0)}% average, room for optimization`);
    } else {
      insights.push(
        `Below-target availability: ${averageAvailability.toFixed(0)}% average needs improvement`
      );
    }
  }

  // Meeting efficiency insights
  const totalMeetingHours =
    (categoryStats?.external_meeting?.hours || 0) + (categoryStats?.internal_meeting?.hours || 0);
  const meetingEfficiencyRatio =
    totalWorkingHours && totalWorkingHours > 0 ? (totalMeetingHours / totalWorkingHours) * 100 : 0;

  if (meetingEfficiencyRatio > 80) {
    insights.push(`Meeting-heavy schedule: ${meetingEfficiencyRatio.toFixed(0)}% of time in meetings`);
  } else if (meetingEfficiencyRatio < 30) {
    insights.push(
      `Light meeting load: ${meetingEfficiencyRatio.toFixed(0)}% of time in meetings, good for deep work`
    );
  }

  // External meeting capacity insights
  const remainingCapacity = potentialExternalCalls - (categoryStats?.external_meeting?.count || 0);
  if (remainingCapacity > 10) {
    insights.push(`High external capacity: Could accommodate ${remainingCapacity} more client meetings`);
  } else if (remainingCapacity > 0) {
    insights.push(`Limited external capacity: ${remainingCapacity} additional meeting slots available`);
  } else {
    insights.push(`At capacity: No additional external meeting slots available`);
  }

  // Work-life balance insights
  const totalAfterHours = externalAfterHours + internalAfterHours;
  if (totalAfterHours < 2) {
    insights.push(`Excellent work-life balance: Minimal after-hours commitments`);
  } else if (totalAfterHours > 10) {
    insights.push(`Work-life balance concern: ${Math.round(totalAfterHours)}h of after-hours meetings`);
  }

  // Day-of-week patterns
  if (bestDay && worstDay && bestDay.day !== worstDay.day) {
    const variance = bestDay.availabilityPercentage - worstDay.availabilityPercentage;
    if (variance > 40) {
      insights.push(
        `High day-to-day variance: ${variance.toFixed(0)}% difference between best and worst days`
      );
    }
  }

  return {
    healthStatus: {
      status: healthStatus,
      color: healthColor,
      percentage: availabilityPercentage,
      availabilityPercentage: availabilityPercentage, // Add this for frontend compatibility
      label: healthStatus === "healthy" ? "HEALTHY" : healthStatus === "warning" ? "WARNING" : "CRITICAL",
      message:
        healthStatus === "healthy"
          ? `${availabilityPercentage.toFixed(1)}% external meeting capacity`
          : healthStatus === "warning"
          ? `${availabilityPercentage.toFixed(1)}% external meeting capacity, monitor closely`
          : `Only ${availabilityPercentage.toFixed(1)}% external meeting capacity`,
    },
    blockingBehavior: {
      score: blockingScore,
      risk: blockingScore >= 70 ? "low" : blockingScore >= 40 ? "medium" : "high",
      riskColor: blockingScore >= 70 ? "🟢" : blockingScore >= 40 ? "🟡" : "🔴",
      selfBlockingHigh: highSelfBlocking,
      internalMeetingsHigh: highInternalMeetings,
    },
    dailyBreakdown: Object.values(dailyAvailability),
    externalCallCapacity: {
      totalAvailableHours: totalAvailableHours,
      potentialCalls: potentialExternalCalls,
      currentUtilization: utilizationRate,
      utilizationLabel:
        utilizationRate >= 80
          ? "Excellent"
          : utilizationRate >= 60
          ? "Good"
          : utilizationRate >= 40
          ? "Fair"
          : "Poor",
    },
    patterns: {
      bestDay: bestDay
        ? {
            day: bestDay.day,
            percentage: bestDay.availabilityPercentage,
          }
        : null,
      worstDay: worstDay
        ? {
            day: worstDay.day,
            percentage: worstDay.availabilityPercentage,
          }
        : null,
    },
    redFlags: redFlags,
    insights: insights,
  };
}

// Helper function to calculate daily breakdown
function calculateDailyBreakdown(
  categorizedBusyTimes: any[],
  startDate: dayjs.Dayjs,
  endDate: dayjs.Dayjs,
  userTimeZone?: string
) {
  const dailyStats: Record<string, any> = {};

  // Dates are already in user timezone from calling function, no need to convert again
  const startDateInTz = startDate;
  const endDateInTz = endDate;

  // Initialize all days
  let currentDate = startDateInTz.clone().startOf("day");
  while (currentDate.isBefore(endDateInTz) || currentDate.isSame(endDateInTz, "day")) {
    const dateKey = currentDate.format("YYYY-MM-DD");
    dailyStats[dateKey] = {
      date: dateKey,
      dayOfWeek: currentDate.day(),
      external_meeting: { count: 0, hours: 0 },
      internal_meeting: { count: 0, hours: 0 },
      self_blocked: { count: 0, hours: 0 },
      unknown: { count: 0, hours: 0 },
      totalBusyHours: 0,
      totalMeetings: 0,
    };
    currentDate = currentDate.add(1, "day");
  }

  // Process each busy time
  categorizedBusyTimes.forEach((busyTime) => {
    const start = dayjs(busyTime.start);
    const end = dayjs(busyTime.end);
    const category = busyTime.category || "unknown";
    const duration = end.diff(start, "hour", true);

    // Convert to user timezone for proper daily classification
    const startInTz = userTimeZone ? start.tz(userTimeZone) : start;
    const endInTz = userTimeZone ? end.tz(userTimeZone) : end;

    // Find all days this event spans in user timezone
    let currentEventDate = startInTz.clone().startOf("day");
    while (currentEventDate.isBefore(endInTz) || currentEventDate.isSame(endInTz, "day")) {
      const dateKey = currentEventDate.format("YYYY-MM-DD");

      if (dailyStats[dateKey]) {
        // Only count each meeting once, on its start day
        if (currentEventDate.isSame(startInTz, "day")) {
          dailyStats[dateKey][category].count++;
          dailyStats[dateKey].totalMeetings++;
        }
        // But distribute hours proportionally across days
        dailyStats[dateKey][category].hours += duration;
        dailyStats[dateKey].totalBusyHours += duration;
      }

      currentEventDate = currentEventDate.add(1, "day");
    }
  });

  return Object.values(dailyStats);
}

// Helper function to calculate weekly breakdown
function calculateWeeklyBreakdown(
  categorizedBusyTimes: any[],
  startDate: dayjs.Dayjs,
  endDate: dayjs.Dayjs,
  userTimeZone?: string
) {
  const weeklyStats: Record<string, any> = {};

  // Dates are already in user timezone from calling function, no need to convert again
  const startDateInTz = startDate;
  const endDateInTz = endDate;

  // Initialize all weeks
  let currentDate = startDateInTz.clone().startOf("week");
  while (currentDate.isBefore(endDateInTz) || currentDate.isSame(endDateInTz, "week")) {
    const weekKey = currentDate.format("YYYY-[W]WW");
    const weekEnd = currentDate.clone().endOf("week");

    weeklyStats[weekKey] = {
      weekStart: currentDate.format("YYYY-MM-DD"),
      weekEnd: weekEnd.format("YYYY-MM-DD"),
      weekNumber: Math.ceil(currentDate.date() / 7),
      year: currentDate.year(),
      external_meeting: { count: 0, hours: 0 },
      internal_meeting: { count: 0, hours: 0 },
      self_blocked: { count: 0, hours: 0 },
      unknown: { count: 0, hours: 0 },
      totalBusyHours: 0,
      totalMeetings: 0,
    };
    currentDate = currentDate.add(1, "week");
  }

  // Process each busy time
  categorizedBusyTimes.forEach((busyTime) => {
    const start = dayjs(busyTime.start);
    const category = busyTime.category || "unknown";
    const duration = dayjs(busyTime.end).diff(start, "hour", true);

    // Convert to user timezone for proper week classification
    const startInTz = userTimeZone ? start.tz(userTimeZone) : start;
    const weekKey = startInTz.format("YYYY-[W]WW");

    if (weeklyStats[weekKey]) {
      weeklyStats[weekKey][category].count++;
      weeklyStats[weekKey][category].hours += duration;
      weeklyStats[weekKey].totalBusyHours += duration;
      weeklyStats[weekKey].totalMeetings++;
    }
  });

  return Object.values(weeklyStats);
}

// Helper function to calculate monthly breakdown
function calculateMonthlyBreakdown(
  categorizedBusyTimes: any[],
  startDate: dayjs.Dayjs,
  endDate: dayjs.Dayjs,
  userTimeZone?: string
) {
  const monthlyStats: Record<string, any> = {};

  // Dates are already in user timezone from calling function, no need to convert again
  const startDateInTz = startDate;
  const endDateInTz = endDate;

  // Initialize all months
  let currentDate = startDateInTz.clone().startOf("month");
  while (currentDate.isBefore(endDateInTz) || currentDate.isSame(endDateInTz, "month")) {
    const monthKey = currentDate.format("YYYY-MM");

    monthlyStats[monthKey] = {
      month: currentDate.format("YYYY-MM"),
      monthName: currentDate.format("MMMM YYYY"),
      year: currentDate.year(),
      external_meeting: { count: 0, hours: 0 },
      internal_meeting: { count: 0, hours: 0 },
      self_blocked: { count: 0, hours: 0 },
      unknown: { count: 0, hours: 0 },
      totalBusyHours: 0,
      totalMeetings: 0,
    };
    currentDate = currentDate.add(1, "month");
  }

  // Process each busy time
  categorizedBusyTimes.forEach((busyTime) => {
    const start = dayjs(busyTime.start);
    const category = busyTime.category || "unknown";
    const duration = dayjs(busyTime.end).diff(start, "hour", true);

    // Convert to user timezone for proper month classification
    const startInTz = userTimeZone ? start.tz(userTimeZone) : start;
    const monthKey = startInTz.format("YYYY-MM");

    if (monthlyStats[monthKey]) {
      monthlyStats[monthKey][category].count++;
      monthlyStats[monthKey][category].hours += duration;
      monthlyStats[monthKey].totalBusyHours += duration;
      monthlyStats[monthKey].totalMeetings++;
    }
  });

  return Object.values(monthlyStats);
}

// Helper function to get user email
async function getUserEmail(userId: number): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return user?.email || "";
}

// Helper function to detect and resolve overlapping meetings
function resolveOverlappingMeetings(meetings: any[]): any[] {
  if (meetings.length <= 1) return meetings;

  // Sort meetings by start time
  const sortedMeetings = [...meetings].sort((a, b) => dayjs(a.start).valueOf() - dayjs(b.start).valueOf());

  // First pass: collect all overlaps and calculate total overlap time
  let totalOverlapTime = 0;
  const overlaps: Array<{
    meeting1: any;
    meeting2: any;
    overlapStart: dayjs.Dayjs;
    overlapEnd: dayjs.Dayjs;
    duration: number;
  }> = [];

  for (let i = 0; i < sortedMeetings.length; i++) {
    for (let j = i + 1; j < sortedMeetings.length; j++) {
      const meeting1 = sortedMeetings[i];
      const meeting2 = sortedMeetings[j];

      const start1 = dayjs(meeting1.start);
      const end1 = dayjs(meeting1.end);
      const start2 = dayjs(meeting2.start);
      const end2 = dayjs(meeting2.end);

      // Check if meetings overlap
      if (start1.isBefore(end2) && end1.isAfter(start2)) {
        const overlapStart = start1.isAfter(start2) ? start1 : start2;
        const overlapEnd = end1.isBefore(end2) ? end1 : end2;
        const duration = overlapEnd.diff(overlapStart, "hour", true);

        if (duration > 0) {
          overlaps.push({
            meeting1,
            meeting2,
            overlapStart,
            overlapEnd,
            duration,
          });
          totalOverlapTime += duration;
        }
      }
    }
  }

  // Process overlaps

  // Second pass: resolve overlaps by priority
  const resolvedMeetings: any[] = [];
  const processedTimeRanges: Array<{ start: dayjs.Dayjs; end: dayjs.Dayjs; category: string; meeting: any }> =
    [];

  for (const meeting of sortedMeetings) {
    const meetingStart = dayjs(meeting.start);
    const meetingEnd = dayjs(meeting.end);
    const meetingCategory = meeting.category || "unknown";

    // Check for overlaps with already processed time ranges
    let hasOverlap = false;
    const overlappingRanges: Array<{ start: dayjs.Dayjs; end: dayjs.Dayjs; category: string; meeting: any }> =
      [];

    for (const range of processedTimeRanges) {
      // Check if there's an overlap
      if (meetingStart.isBefore(range.end) && meetingEnd.isAfter(range.start)) {
        hasOverlap = true;
        overlappingRanges.push(range);
      }
    }

    if (hasOverlap) {
      // Handle overlapping meetings by prioritizing categories
      // Priority order: external_meeting > internal_meeting > self_blocked > unknown
      const categoryPriority: Record<string, number> = {
        external_meeting: 4,
        internal_meeting: 3,
        self_blocked: 2,
        unknown: 1,
      };

      const currentPriority = categoryPriority[meetingCategory] || 1;
      let shouldKeepCurrent = true;

      for (const overlappingRange of overlappingRanges) {
        const overlappingPriority = categoryPriority[overlappingRange.category] || 1;

        if (overlappingPriority > currentPriority) {
          shouldKeepCurrent = false;
          break;
        } else if (overlappingPriority === currentPriority) {
          // Same priority, keep the one that starts earlier
          if (meetingStart.isAfter(overlappingRange.start)) {
            shouldKeepCurrent = false;
            break;
          }
        }
      }

      if (shouldKeepCurrent) {
        // Current meeting has higher priority, replace overlapping ranges
        const newProcessedRanges: Array<{
          start: dayjs.Dayjs;
          end: dayjs.Dayjs;
          category: string;
          meeting: any;
        }> = [];

        // Add non-overlapping parts of existing ranges
        for (const range of processedTimeRanges) {
          if (!(meetingStart.isBefore(range.end) && meetingEnd.isAfter(range.start))) {
            // No overlap, keep as is
            newProcessedRanges.push(range);
          } else {
            // There's an overlap, split the existing range
            const rangeStart = range.start;
            const rangeEnd = range.end;

            // Add part before overlap (if any)
            if (rangeStart.isBefore(meetingStart)) {
              const preSegment = {
                start: rangeStart,
                end: meetingStart,
                category: range.category,
                meeting: range.meeting,
              };
              newProcessedRanges.push(preSegment);
            }

            // Add part after overlap (if any)
            if (rangeEnd.isAfter(meetingEnd)) {
              const postSegment = {
                start: meetingEnd,
                end: rangeEnd,
                category: range.category,
                meeting: range.meeting,
              };
              newProcessedRanges.push(postSegment);
            }
          }
        }

        // Add the current meeting
        newProcessedRanges.push({ start: meetingStart, end: meetingEnd, category: meetingCategory, meeting });
        processedTimeRanges.splice(0, processedTimeRanges.length, ...newProcessedRanges);
        resolvedMeetings.push(meeting);
      } else {
        // Current meeting has lower priority, split it around existing meetings
        const newMeetings: any[] = [];

        for (const overlappingRange of overlappingRanges) {
          const rangeStart = overlappingRange.start;
          const rangeEnd = overlappingRange.end;

          // Add part before overlap (if any)
          if (meetingStart.isBefore(rangeStart)) {
            const splitMeeting = {
              ...meeting,
              start: meetingStart.toISOString(),
              end: rangeStart.toISOString(),
            };
            newMeetings.push(splitMeeting);
          }

          // Add part after overlap (if any)
          if (meetingEnd.isAfter(rangeEnd)) {
            const splitMeeting = {
              ...meeting,
              start: rangeEnd.toISOString(),
              end: meetingEnd.toISOString(),
            };
            newMeetings.push(splitMeeting);
          }
        }

        // Add the split meetings to resolved meetings
        resolvedMeetings.push(...newMeetings);
      }
    } else {
      // No overlap, add the meeting
      processedTimeRanges.push({ start: meetingStart, end: meetingEnd, category: meetingCategory, meeting });
      resolvedMeetings.push(meeting);
    }
  }

  // Convert the final processedTimeRanges back to meeting objects to get the properly split segments
  const finalResolvedMeetings = processedTimeRanges.map((range) => ({
    ...range.meeting,
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    category: range.category,
  }));

  // Return the properly resolved meetings

  return finalResolvedMeetings;
}
