import { withAppDirSsr } from "app/WithAppDirSsr";
import type { PageProps } from "app/_types";
import { generateMeetingMetadata } from "app/_utils";
import { headers, cookies } from "next/headers";

import { getOrgFullOrigin } from "@calcom/features/ee/organizations/lib/orgDomains";
import { RedisService } from "@calcom/features/redis/RedisService";
import { trackEvent } from "@calcom/lib/analytics";

import { buildLegacyCtx, decodeParams } from "@lib/buildLegacyCtx";

import { getServerSideProps } from "@server/lib/[user]/[type]/getServerSideProps";

import type { PageProps as LegacyPageProps } from "~/users/views/users-type-public-view";
import LegacyPage from "~/users/views/users-type-public-view";

export const generateMetadata = async ({ params, searchParams }: PageProps) => {
  const legacyCtx = buildLegacyCtx(await headers(), await cookies(), await params, await searchParams);
  const props = await getData(legacyCtx);

  const { booking, isSEOIndexable = true, eventData, isBrandingHidden } = props;
  const rescheduleUid = booking?.uid;
  const profileName = eventData?.profile?.name ?? "";
  const profileImage = eventData?.profile.image;
  const title = eventData?.title ?? "";
  const meeting = {
    title,
    profile: { name: profileName, image: profileImage },
    users: [
      ...(eventData?.subsetOfUsers || []).map((user) => ({
        name: `${user.name}`,
        username: `${user.username}`,
      })),
    ],
  };
  const decodedParams = decodeParams(await params);
  const metadata = await generateMeetingMetadata(
    meeting,
    (t) => `${rescheduleUid && !!booking ? t("reschedule") : ""} ${title} | ${profileName}`,
    (t) => `${rescheduleUid ? t("reschedule") : ""} ${title}`,
    isBrandingHidden,
    getOrgFullOrigin(eventData?.entity.orgSlug ?? null),
    `/${decodedParams.user}/${decodedParams.type}`
  );

  return {
    ...metadata,
    robots: {
      follow: !(eventData?.hidden || !isSEOIndexable),
      index: !(eventData?.hidden || !isSEOIndexable),
    },
  };
};
const getData = withAppDirSsr<LegacyPageProps>(getServerSideProps);

const ServerPage = async ({ params, searchParams }: PageProps) => {
  const legacyCtx = buildLegacyCtx(await headers(), await cookies(), await params, await searchParams);
  const props = await getData(legacyCtx);
  const redisClient = new RedisService();

  // Get the URL path parameters for user and type
  const { user, type } = await params;

  // Construct the key for redis
  const queryParams = await searchParams;
  const key = `bookingPageVisited|${user}|${type}|${queryParams?.t_source}|${queryParams?.t_account_id}|${queryParams?.t_user_id}`;
  const isBookingPageVisited = await redisClient.get(key);
  // Check if the user has not visited the booking page previously in 1 day and if they have, track the event
  if (
    !isBookingPageVisited &&
    (queryParams["t_source"] || queryParams["t_account_id"] || queryParams["t_user_id"])
  ) {
    const eventData = {
      source: queryParams["t_source"],
      accountId: queryParams["t_account_id"],
      userId: queryParams["t_user_id"],
    };
    trackEvent("SETUP_MEETING_ATTEMPTED", eventData);

    // Set key in redis
    await redisClient.set(key, 1);
    await redisClient.expire(key, 86400); // expire in 1 day
  }

  return <LegacyPage {...props} />;
};

export default ServerPage;
