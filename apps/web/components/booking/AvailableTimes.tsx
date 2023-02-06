import { EventType } from "@prisma/client";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/router";
import { FC, useEffect, useMemo, useState } from "react";

import { getEventLocationValue } from "@calcom/app-store/locations";
import { LocationObject } from "@calcom/core/location";
import dayjs, { Dayjs } from "@calcom/dayjs";
import { sdkActionManager } from "@calcom/embed-core/embed-iframe";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { nameOfDay } from "@calcom/lib/weekday";
import type { Slot } from "@calcom/trpc/server/routers/viewer/slots";
import { SkeletonContainer, SkeletonText } from "@calcom/ui";

import classNames from "@lib/classNames";
import { timeZone } from "@lib/clock";
import createBooking from "@lib/mutations/bookings/create-booking";

type AvailableTimesProps = {
  timeFormat: string;
  eventTypeId: number;
  recurringCount: number | undefined;
  eventTypeSlug: string;
  date: Dayjs;
  seatsPerTimeSlot?: number | null;
  slots?: Slot[];
  isLoading: boolean;
  profile: { slug: string | null; eventName?: string | null };
  eventType: Pick<EventType, "length" | "locations">;
};

const AvailableTimes: FC<AvailableTimesProps> = ({
  slots = [],
  isLoading,
  date,
  eventTypeId,
  eventTypeSlug,
  recurringCount,
  timeFormat,
  seatsPerTimeSlot,
  profile,
  eventType,
}) => {
  const { t, i18n } = useLocale();
  const router = useRouter();
  const { rescheduleUid } = router.query;

  const [brand, setBrand] = useState("#292929");
  const [selectedSlot, setSelectedSlot] = useState<Slot>();

  const locations: LocationObject[] = useMemo(
    () => (eventType.locations as LocationObject[]) || [],
    [eventType.locations]
  );

  const mutation = useMutation(createBooking, {
    onSuccess: async (responseData) => {
      const { id, uid, attendees, startTime, endTime, title } = responseData;
      if (sdkActionManager) {
        sdkActionManager.fire("bookingSuccess", {
          startTime,
          endTime,
          title,
          uid,
          type: eventTypeId,
          eventSlug: eventTypeSlug,
          user: profile.slug,
          reschedule: !!rescheduleUid,
          name: attendees[0].name,
          email: attendees[0].email,
          location: responseData.location,
          eventName: profile.eventName || "",
          bookingId: id,
          isSuccessBookingPage: true,
        });
      }
      return true;
    },
    onError: async (error) => {
      if (sdkActionManager) {
        sdkActionManager.fire("bookingError", {
          error: JSON.stringify(error),
          isSuccessBookingPage: false,
        });
      }
    },
  });

  if (window.isEmbed()) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    window.eventAttached ||
      window.addEventListener("message", (e) => {
        const data: Record<string, any> = e.data;
        if (!data) {
          return;
        }
        if (data.originator === "VWO") {
          bookMeeting(data.slot, data.email, data.name);
        }
      });

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    window.eventAttached = true;

    const bookMeeting = (
      slot: {
        time: string | number | dayjs.Dayjs | Date | null | undefined;
        bookingUid: string;
      },
      email: string,
      name: string
    ) => {
      if (
        (router.query.email !== "null" || email !== null) &&
        (router.query.name !== "null" || name !== null)
      ) {
        mutation.mutate({
          start: dayjs(slot.time).format(),
          end: dayjs(slot.time).add(eventType.length, "minute").format(),
          eventTypeId,
          eventTypeSlug,
          timeZone: timeZone(),
          language: i18n.language,
          rescheduleUid: rescheduleUid as string,
          bookingUid: slot.bookingUid,
          user: router.query.user,
          metadata: {},
          hasHashedBookingLink: false,
          hashedLink: "",
          email: (email as string) || (router.query.email as string),
          name: (name as string) || (router.query.name as string),
          noEmail: true,
          customInputs: [],
          location: getEventLocationValue(locations, {
            type: eventType.locations ? locations[0]?.type : "",
          }),
        });
      }
    };
  }

  useEffect(() => {
    setBrand(getComputedStyle(document.documentElement).getPropertyValue("--brand-color").trim());
    if (selectedSlot && date.format("YYYY-MM-DD") === dayjs(selectedSlot.time).format("YYYY-MM-DD")) {
      if (sdkActionManager) {
        sdkActionManager.fire("dateTimeSelected", {
          slot: selectedSlot,
        });
      }
    } else {
      if (sdkActionManager) {
        sdkActionManager.fire("dateChanged", {
          date: date.format("YYYY-MM-DD"),
        });
      }
    }
  }, [date, selectedSlot]);

  return (
    <div className="dark:bg-darkgray-100 mt-8 flex flex-col px-4 text-center sm:mt-0 sm:w-1/2 sm:p-5 md:-mb-5">
      <div className="mb-4 text-left text-base">
        <span className="text-bookingdarker dark:text-darkgray-800 mb-8 w-1/2 break-words font-semibold text-gray-900">
          {nameOfDay(i18n.language, Number(date.format("d")))}
        </span>
        <span className="text-bookinglight font-medium">
          {date.format(", D ")}
          {date.toDate().toLocaleString(i18n.language, { month: "long" })}
        </span>
      </div>
      <div className="grid flex-grow grid-cols-1 gap-x-2 overflow-y-auto sm:block md:h-[364px]">
        {slots.length > 0 &&
          slots.map((slot) => {
            type BookingURL = {
              pathname: string;
              query: Record<string, string | number | string[] | undefined>;
            };
            const bookingUrl: BookingURL = {
              pathname: "book",
              query: {
                ...router.query,
                date: dayjs(slot.time).format(),
                type: eventTypeId,
                slug: eventTypeSlug,
                /** Treat as recurring only when a count exist and it's not a rescheduling workflow */
                count: recurringCount && !rescheduleUid ? recurringCount : undefined,
              },
            };

            if (rescheduleUid) {
              bookingUrl.query.rescheduleUid = rescheduleUid as string;
            }

            // If event already has an attendee add booking id
            if (slot.bookingUid) {
              bookingUrl.query.bookingUid = slot.bookingUid;
            }

            const handleClick = (e: { preventDefault: () => void }) => {
              if (window.isEmbed()) {
                setSelectedSlot(slot);
                e.preventDefault();
              } else {
                return true;
              }
            };

            return (
              <div key={dayjs(slot.time).format()}>
                {/* Current there is no way to disable Next.js Links */}
                {seatsPerTimeSlot && slot.attendees && slot.attendees >= seatsPerTimeSlot ? (
                  <div
                    className={classNames(
                      "text-primary-500 dark:bg-darkgray-200 dark:text-darkgray-900 mb-2 block rounded-sm border bg-white py-2  font-medium opacity-25 dark:border-transparent ",
                      brand === "#fff" || brand === "#ffffff" ? "" : ""
                    )}>
                    {dayjs(slot.time).tz(timeZone()).format(timeFormat)}
                    {!!seatsPerTimeSlot && <p className="text-sm">{t("booking_full")}</p>}
                  </div>
                ) : (
                  <Link href={bookingUrl} prefetch={false}>
                    <a
                      className={classNames(
                        "text-primary-500 hover:border-gray-900 hover:bg-gray-50",
                        window.isEmbed() && selectedSlot && selectedSlot.time === slot.time
                          ? "bg-darkgray-200 hover:bg-darkgray-300 hover:border-darkmodebrand dark:text-primary-500 border-transparent text-neutral-200 dark:bg-white"
                          : "dark:bg-darkgray-200 dark:hover:border-darkgray-300 dark:hover:border-darkmodebrand bg-white dark:border-transparent dark:text-neutral-200",
                        "mb-2 block rounded-md border py-2 text-sm font-medium",
                        brand === "#fff" || brand === "#ffffff" ? "border-brandcontrast" : "border-brand"
                      )}
                      data-testid="time"
                      onClick={handleClick}>
                      {dayjs(slot.time).tz(timeZone()).format(timeFormat)}
                      {!!seatsPerTimeSlot && (
                        <p
                          className={`${
                            slot.attendees && slot.attendees / seatsPerTimeSlot >= 0.8
                              ? "text-rose-600"
                              : slot.attendees && slot.attendees / seatsPerTimeSlot >= 0.33
                              ? "text-yellow-500"
                              : "text-emerald-400"
                          } text-sm`}>
                          {slot.attendees ? seatsPerTimeSlot - slot.attendees : seatsPerTimeSlot} /{" "}
                          {seatsPerTimeSlot} {t("seats_available")}
                        </p>
                      )}
                    </a>
                  </Link>
                )}
              </div>
            );
          })}

        {!isLoading && !slots.length && (
          <div className="-mt-4 flex h-full w-full flex-col content-center items-center justify-center">
            <h1 className="my-6 text-xl text-black dark:text-white">{t("all_booked_today")}</h1>
          </div>
        )}

        {isLoading && !slots.length && (
          <>
            <SkeletonContainer className="mb-2">
              <SkeletonText width="full" height="20" />
            </SkeletonContainer>
            <SkeletonContainer className="mb-2">
              <SkeletonText width="full" height="20" />
            </SkeletonContainer>
            <SkeletonContainer className="mb-2">
              <SkeletonText width="full" height="20" />
            </SkeletonContainer>
          </>
        )}
      </div>
    </div>
  );
};

export default AvailableTimes;
