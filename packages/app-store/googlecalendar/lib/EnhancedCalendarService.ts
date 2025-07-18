import type { EventBusyDate, IntegrationCalendar } from "@calcom/types/Calendar";

import GoogleCalendarService from "./CalendarService";

interface CategorizedBusyTime extends EventBusyDate {
  category: "external_meeting" | "internal_meeting" | "self_blocked" | "unknown";
  eventTitle?: string;
  attendees?: string[];
  organizer?: string;
  isExternal?: boolean;
  eventId?: string;
  description?: string;
  transparency?: string;
}

export default class EnhancedGoogleCalendarService extends GoogleCalendarService {
  async getAvailabilityWithCategories(
    dateFrom: string,
    dateTo: string,
    selectedCalendars: IntegrationCalendar[]
  ): Promise<CategorizedBusyTime[]> {
    // Get basic busy times from parent class
    const busyTimes = await this.getAvailability(dateFrom, dateTo, selectedCalendars);

    // Categorize each busy time
    const categorizedBusyTimes: CategorizedBusyTime[] = busyTimes.map((busyTime) => {
      const category = this.categorizeBusyTime(busyTime);
      return {
        ...busyTime,
        category,
        eventTitle: "Event", // Placeholder - would be filled with actual event data
        attendees: [],
        organizer: "",
        isExternal: category === "external_meeting",
        eventId: "",
        description: "",
        transparency: "opaque",
      };
    });

    return categorizedBusyTimes;
  }

  private categorizeBusyTime(
    busyTime: EventBusyDate
  ): "external_meeting" | "internal_meeting" | "self_blocked" | "unknown" {
    // For now, we'll use a simple categorization based on source
    // In a full implementation, this would analyze the actual event details

    // If it's from Cal.com bookings, it's likely an external meeting
    if (busyTime.source?.includes("eventType-") || busyTime.source?.includes("booking-")) {
      return "external_meeting";
    }

    // If it's from Google Calendar, we'll categorize as external for now
    if (busyTime.source?.includes("google_calendar")) {
      return "external_meeting";
    }

    // Default categorization
    return "unknown";
  }

  // Override the base getAvailability to provide categorized data
  async getAvailability(
    dateFrom: string,
    dateTo: string,
    selectedCalendars: IntegrationCalendar[]
  ): Promise<EventBusyDate[]> {
    const categorized = await this.getAvailabilityWithCategories(dateFrom, dateTo, selectedCalendars);
    return categorized.map(({ start, end, source }) => ({ start, end, source }));
  }
}
