import { Webhook } from "@prisma/client";
import { createHmac } from "crypto";
import { compile } from "handlebars";

import dayjs from "@calcom/dayjs";
import type { CalendarEvent } from "@calcom/types/Calendar";

type ContentType = "application/json" | "application/x-www-form-urlencoded";

function applyTemplate(template: string, data: CalendarEvent, contentType: ContentType) {
  const compiled = compile(template)(data);
  if (contentType === "application/json") {
    return JSON.stringify(jsonParse(compiled));
  }
  return compiled;
}

function jsonParse(jsonString: string) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    // don't do anything.
  }
  return false;
}

const sendPayload = async (
  secretKey: string | null,
  triggerEvent: string,
  createdAt: string,
  webhook: Pick<Webhook, "subscriberUrl" | "appId" | "payloadTemplate">,
  data: CalendarEvent & {
    metadata?: { [key: string]: string };
    rescheduleUid?: string;
    bookingId?: number;
    triggerEvent?: string;
    adjustedStartTime?: string;
    adjustedEndTime?: string;
  }
) => {
  const { appId, payloadTemplate: template } = webhook;

  const contentType =
    !template || jsonParse(template) ? "application/json" : "application/x-www-form-urlencoded";

  data.description = data.description || data.additionalNotes;

  data.triggerEvent = data.organizer.language.translate(triggerEvent.toLowerCase());
  data.adjustedStartTime = dayjs(data.startTime).tz(data.organizer.timeZone).format("lll");
  data.adjustedEndTime = dayjs(data.endTime).tz(data.organizer.timeZone).format("lll");

  let body;

  /* Zapier id is hardcoded in the DB, we send the raw data for this case  */
  if (appId === "zapier") {
    body = JSON.stringify(data);
  } else if (template) {
    body = applyTemplate(template, data, contentType);
  } else {
    body = JSON.stringify({
      triggerEvent: triggerEvent,
      createdAt: createdAt,
      payload: data,
    });
  }

  return _sendPayload(secretKey, triggerEvent, createdAt, webhook, body, contentType);
};

export const sendGenericWebhookPayload = async (
  secretKey: string | null,
  triggerEvent: string,
  createdAt: string,
  webhook: Pick<Webhook, "subscriberUrl" | "appId" | "payloadTemplate">,
  data: Record<string, unknown>
) => {
  const body = JSON.stringify(data);
  return _sendPayload(secretKey, triggerEvent, createdAt, webhook, body, "application/json");
};

const _sendPayload = async (
  secretKey: string | null,
  triggerEvent: string,
  createdAt: string,
  webhook: Pick<Webhook, "subscriberUrl" | "appId" | "payloadTemplate">,
  body: string,
  contentType: "application/json" | "application/x-www-form-urlencoded"
) => {
  const { subscriberUrl } = webhook;
  if (!subscriberUrl || !body) {
    throw new Error("Missing required elements to send webhook payload.");
  }

  const secretSignature = secretKey
    ? createHmac("sha256", secretKey).update(`${body}`).digest("hex")
    : "no-secret-provided";

  const response = await fetch(subscriberUrl, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Cal-Signature-256": secretSignature,
    },
    body,
  });

  const text = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    message: text,
  };
};

export default sendPayload;