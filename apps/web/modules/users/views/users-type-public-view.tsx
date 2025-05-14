"use client";

import type { EmbedProps } from "app/WithEmbedSSR";
import Cookies from "js-cookie";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { BookerWebWrapper as Booker } from "@calcom/atoms/booker";
import { getBookerWrapperClasses } from "@calcom/features/bookings/Booker/utils/getBookerWrapperClasses";

import type { inferSSRProps } from "@lib/types/inferSSRProps";

import BookingPageErrorBoundary from "@components/error/BookingPageErrorBoundary";

import type { getServerSideProps } from "@server/lib/[user]/[type]/getServerSideProps";

export type PageProps = inferSSRProps<typeof getServerSideProps> &
  EmbedProps & {
    cookieName: string;
    cookieValue: string;
  };

export const getMultipleDurationValue = (
  multipleDurationConfig: number[] | undefined,
  queryDuration: string | string[] | null | undefined,
  defaultValue: number
) => {
  if (!multipleDurationConfig) return null;
  if (multipleDurationConfig.includes(Number(queryDuration))) return Number(queryDuration);
  return defaultValue;
};

function Type({
  slug,
  user,
  isEmbed,
  booking,
  isBrandingHidden,
  eventData,
  orgBannerUrl,
  cookieName,
  cookieValue,
}: PageProps) {
  const searchParams = useSearchParams();

  useEffect(() => {
    Cookies.set(cookieName, cookieValue, { expires: 1 }); // expires in 1 days
  }, []);

  return (
    <BookingPageErrorBoundary>
      <main className={getBookerWrapperClasses({ isEmbed: !!isEmbed })}>
        <Booker
          username={user}
          eventSlug={slug}
          bookingData={booking}
          hideBranding={isBrandingHidden}
          eventData={eventData}
          entity={{ ...eventData.entity, eventTypeId: eventData?.id }}
          durationConfig={eventData.metadata?.multipleDuration}
          orgBannerUrl={orgBannerUrl}
          /* TODO: Currently unused, evaluate it is needed-
           *       Possible alternative approach is to have onDurationChange.
           */
          duration={getMultipleDurationValue(
            eventData.metadata?.multipleDuration,
            searchParams?.get("duration"),
            eventData.length
          )}
        />
      </main>
    </BookingPageErrorBoundary>
  );
}

export default Type;
