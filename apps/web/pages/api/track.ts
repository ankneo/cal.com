import { NextApiRequest, NextApiResponse } from "next";

import { trackEvent } from "@calcom/lib/analytics";

const trackingParamPrefix = "t_";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const trackEventNames = {
    booking_page_view: "SETUP_MEETING_ATTEMPTED",
  };

  try {
    const { eventData, event } = req.body;

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
    trackEvent(eventName, eventData, eventData["t_user_id"]);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Tracking error:", error);
    return res.status(500).json({ message: "Error tracking event" });
  }
}
