import { NextApiRequest, NextApiResponse } from "next";

import { trackEvent } from "@calcom/lib/analytics";

const trackingParamPrefix = "t_";

type TrackingEvents = {
  booking_page_view: "SETUP_MEETING_ATTEMPTED";
};

type EventData = {
  [key: string]: string | string[] | undefined;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const trackEventNames: TrackingEvents = {
    booking_page_view: "SETUP_MEETING_ATTEMPTED",
  } as const;

  try {
    const { eventData, event }: { eventData: EventData; event: keyof TrackingEvents } = req.body;

    // Check if the event is valid
    if (!trackEventNames[event]) {
      return res.status(400).json({ message: "Invalid event" });
    }
    // Check if the event is valid
    if (!eventData) {
      return res.status(400).json({ message: "Invalid event data" });
    }

    // Initialise
    const eventName = trackEventNames[event];

    // Sanitise the event data
    Object.keys(eventData).forEach((key) => {
      if (!key.startsWith(trackingParamPrefix)) {
        delete eventData[key];
      }
    });

    // Track the event with the provided data
    const userId = typeof eventData["t_user_id"] === "string" ? eventData["t_user_id"] : undefined;
    trackEvent(eventName, eventData, userId);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Tracking error:", error);
    return res.status(500).json({ message: "Error tracking event" });
  }
}
