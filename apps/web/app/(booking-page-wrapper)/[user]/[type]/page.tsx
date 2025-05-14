import { withAppDirSsr } from "app/WithAppDirSsr";
import type { PageProps } from "app/_types";
import { generateMeetingMetadata } from "app/_utils";
import { headers, cookies } from "next/headers";

import { getOrgFullOrigin } from "@calcom/features/ee/organizations/lib/orgDomains";
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

  // Get the URL path parameters for user and type
  const { user, type } = await params;

  // Determine does the user have a cookie that says they've visited the booking page
  const cookieStore = await cookies();
  const queryParams = await searchParams;
  const cookieName = `bookingPageVisited|${user}|${type}|${queryParams?.t_source}`;
  const cookieValue = `${queryParams?.t_account_id}|${queryParams?.t_user_id}`;
  const isBookingPageVisited = cookieStore.get(cookieName);

  // Check if the user has not visited the booking page previously in 1 day and if they have, track the event
  if (
    isBookingPageVisited?.value !== cookieValue &&
    (queryParams["t_source"] || queryParams["t_account_id"] || queryParams["t_user_id"])
  ) {
    const eventData = {
      source: queryParams["t_source"],
      accountId: queryParams["t_account_id"],
      userId: queryParams["t_user_id"],
    };
    trackEvent("SETUP_MEETING_ATTEMPTED", eventData);

    // Set the cookie for the booking page
    props.cookieName = cookieName;
    props.cookieValue = cookieValue;
  }

  return <LegacyPage {...props} />;
};

export default ServerPage;
