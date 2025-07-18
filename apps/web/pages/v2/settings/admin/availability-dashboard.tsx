import { GetServerSidePropsContext } from "next";
import { useState } from "react";

import dayjs from "@calcom/dayjs";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import Button from "@calcom/ui/Button";
import Meta from "@calcom/ui/v2/core/Meta";
import { getLayout } from "@calcom/ui/v2/core/layouts/AdminLayout";

import { getSession } from "@lib/auth";

import AvailabilityDashboard from "@components/admin/AvailabilityDashboard";

interface Props {
  users: Array<{
    id: number;
    name: string | null;
    email: string;
    username: string | null;
    timeZone: string;
  }>;
}

export default function AvailabilityDashboardPage({ users }: Props) {
  const [selectedDate, setSelectedDate] = useState(dayjs());
  const [selectedUsers, setSelectedUsers] = useState<number[]>([]);

  return (
    <>
      <Meta
        title="Availability Dashboard"
        description="Monitor user availability and categorize busy times across your organization"
      />
      <div className="space-y-6">
        <AvailabilityDashboard
          users={users}
          selectedDate={selectedDate}
          setSelectedDate={setSelectedDate}
          selectedUsers={selectedUsers}
          setSelectedUsers={setSelectedUsers}
        />
      </div>
    </>
  );
}

export async function getServerSideProps(context: GetServerSidePropsContext) {
  const session = await getSession(context);

  if (!session?.user?.id) {
    return { redirect: { permanent: false, destination: "/auth/login" } };
  }

  if (session.user.role !== "ADMIN") {
    return { redirect: { permanent: false, destination: "/settings" } };
  }

  // For now, we'll fetch users on the client side using TRPC
  // In a production app, you might want to fetch this server-side
  return {
    props: {
      users: [],
    },
  };
}

AvailabilityDashboardPage.getLayout = getLayout;
