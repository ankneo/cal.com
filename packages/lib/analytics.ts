import { Analytics } from "@segment/analytics-node";

// Initialize Segment
const analytics = new Analytics({
  writeKey: process.env.SEGMENT_WRITE_KEY || "",
});

// Define interface for event data with dynamic keys
interface EventData {
  [key: string]: any;
}

export const trackEvent = async (eventName: string, eventData: EventData): Promise<void> => {
  try {
    // Prepare event data
    const analyticsData = {
      event: eventName,
      properties: eventData,
      userId: eventData.userId || `anonymous-${Date.now()}`,
    };

    // Track event
    await analytics.track(analyticsData);

    if (process.env.NODE_ENV === "development") {
      console.log("Segment event tracked:", { eventName, eventData });
    }
  } catch (error) {
    console.error(`Error tracking ${eventName}:`, error);
  }
};

// Ensure analytics is properly shutdown when the application exits
process.on("beforeExit", () => {
  analytics.closeAndFlush();
});
