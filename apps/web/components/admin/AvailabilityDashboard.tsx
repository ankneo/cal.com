import React, { useState, useEffect } from "react";

import dayjs from "@calcom/dayjs";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Alert } from "@calcom/ui/Alert";
import Button from "@calcom/ui/Button";
import { Icon } from "@calcom/ui/Icon";

import Avatar from "@components/ui/Avatar";

interface User {
  id: number;
  name: string | null;
  email: string;
  username: string | null;
  timeZone: string;
  avatar?: string;
}

interface Props {
  users: User[];
  selectedDate: dayjs.Dayjs;
  setSelectedDate: (date: dayjs.Dayjs) => void;
  selectedUsers: number[];
  setSelectedUsers: (users: number[]) => void;
}

interface CategorizedBusyTime {
  start: string;
  end: string;
  category: "external_meeting" | "internal_meeting" | "self_blocked" | "unknown";
  eventTitle?: string;
  attendees?: string[];
  organizer?: string;
  isExternal?: boolean;
  source?: string;
}

interface UserAvailability {
  userId: number;
  user: User;
  availability: {
    busy: CategorizedBusyTime[];
    timeZone: string;
    workingHours: any;
  };
  categorizedBusyTimes: CategorizedBusyTime[];
  error?: string;
  // Add analytics data structure
  analytics?: {
    totalWorkingHours: number;
    totalBusyHours: number;
    availabilityOverlap: {
      hours: number;
      percentage: number;
    };
    busyTimeOutsideWorkingHours: number;
    meetingsOutsideWorkingHours: Array<{
      title: string;
      start: string;
      end: string;
      category: string;
      duration: number;
      dayOfWeek: number;
      timeOfDay: number;
      userTimeZone?: string;
    }>;
    availableTimeForExternalMeetings: number;
    categoryStats: {
      external_meeting: { count: number; hours: number; percentage: number };
      internal_meeting: { count: number; hours: number; percentage: number };
      self_blocked: { count: number; hours: number; percentage: number };
      unknown: { count: number; hours: number; percentage: number };
    };
    availabilityPercentage: number;
    salesAnalytics?: {
      healthStatus: {
        status: string;
        color: string;
        percentage: number;
        label: string;
        message: string;
      };
      blockingBehavior: {
        score: number;
        risk: string;
        riskColor: string;
        selfBlockingHigh: boolean;
        internalMeetingsHigh: boolean;
      };
      dailyBreakdown: Array<{
        day: string;
        date: string;
        workingHours: number;
        busyHours: number;
        availableHours: number;
        availabilityPercentage: number;
        externalMeetings: number;
        internalMeetings: number;
        selfBlocked: number;
        externalHours: number;
        internalHours: number;
        selfBlockedHours: number;
      }>;
      externalCallCapacity: {
        totalAvailableHours: number;
        potentialCalls: number;
        currentUtilization: number;
        utilizationLabel: string;
      };
      patterns: {
        bestDay: { day: string; percentage: number } | null;
        worstDay: { day: string; percentage: number } | null;
      };
      redFlags: string[];
      insights: string[];
    };
  };
}

// Helper function to convert decimal hours to "Xh Ym" format
const formatHoursMinutes = (decimalHours: number): string => {
  if (decimalHours === 0) return "0h";

  const hours = Math.floor(decimalHours);
  const minutes = Math.round((decimalHours - hours) * 60);

  if (hours === 0) {
    return `${minutes}m`;
  } else if (minutes === 0) {
    return `${hours}h`;
  } else {
    return `${hours}h ${minutes}m`;
  }
};

// Helper function to format availability schedule
const formatAvailabilitySchedule = (workingHours: any[], timeZone: string): string[] => {
  if (!workingHours || workingHours.length === 0) {
    return ["No availability configured"];
  }

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Group by time slots
  const timeSlots: { [key: string]: number[] } = {};

  workingHours.forEach((slot: any) => {
    // The backend already converted from UTC to local by subtracting the UTC offset
    // To display the correct time, we need to add back the offset
    const utcOffset = dayjs().tz(timeZone).utcOffset();

    // Convert back to the intended display time
    const displayStartMinutes = slot.startTime + utcOffset;
    const displayEndMinutes = slot.endTime + utcOffset;

    const startTime = Math.floor(displayStartMinutes / 60);
    const startMinute = displayStartMinutes % 60;
    const endTime = Math.floor(displayEndMinutes / 60);
    const endMinute = displayEndMinutes % 60;

    const timeKey = `${String(startTime).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}-${String(
      endTime
    ).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`;

    if (!timeSlots[timeKey]) {
      timeSlots[timeKey] = [];
    }

    slot.days.forEach((day: number) => {
      if (!timeSlots[timeKey].includes(day)) {
        timeSlots[timeKey].push(day);
      }
    });
  });

  return Object.entries(timeSlots).map(([timeRange, days]) => {
    const sortedDays = days.sort((a, b) => a - b);
    const dayLabels = sortedDays.map((day) => dayNames[day]);

    // Group consecutive days
    const dayGroups: string[] = [];
    let currentGroup = [dayLabels[0]];

    for (let i = 1; i < dayLabels.length; i++) {
      const currentDayIndex = sortedDays[i];
      const prevDayIndex = sortedDays[i - 1];

      if (currentDayIndex === prevDayIndex + 1) {
        currentGroup.push(dayLabels[i]);
      } else {
        if (currentGroup.length > 2) {
          dayGroups.push(`${currentGroup[0]} - ${currentGroup[currentGroup.length - 1]}`);
        } else {
          dayGroups.push(currentGroup.join(", "));
        }
        currentGroup = [dayLabels[i]];
      }
    }

    if (currentGroup.length > 2) {
      dayGroups.push(`${currentGroup[0]} - ${currentGroup[currentGroup.length - 1]}`);
    } else {
      dayGroups.push(currentGroup.join(", "));
    }

    return `${dayGroups.join(", ")}: ${timeRange}`;
  });
};

export default function AvailabilityDashboard({
  users,
  selectedDate,
  setSelectedDate,
  selectedUsers,
  setSelectedUsers,
}: Props) {
  const { t } = useLocale();
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [selectedDayForCalendar, setSelectedDayForCalendar] = useState<dayjs.Dayjs | null>(null);
  const [isOutsideHoursExpanded, setIsOutsideHoursExpanded] = useState<boolean>(false);
  const [expandedAvailability, setExpandedAvailability] = useState<{ [userId: number]: boolean }>({});

  // Fetch users
  const { data: allUsersData, isLoading: isLoadingUsers } = trpc.useQuery(
    ["viewer.admin.availability.getAllUsers"],
    {
      onSuccess: (data: any) => {
        // Users loaded successfully
      },
      onError: (error: any) => {
        console.error("Error loading users:", error);
      },
    }
  );

  useEffect(() => {
    if (allUsersData) {
      setAllUsers(allUsersData);
    }
  }, [allUsersData]);

  // Fetch analytics data - always use monthly view for meaningful analytics
  const { data: analyticsData, isLoading: isLoadingAnalytics } = trpc.useQuery(
    [
      "viewer.admin.availability.getMultiUserAvailability",
      {
        userIds: selectedUsers,
        dateFrom: selectedDate.startOf("month").format("YYYY-MM-DD"),
        dateTo: selectedDate.endOf("month").format("YYYY-MM-DD"),
        includeEventDetails: true,
      },
    ],
    {
      enabled: selectedUsers.length > 0, // Only fetch when users are selected
      refetchInterval: false,
      cacheTime: 5 * 60 * 1000, // 5 minutes
      onSuccess: (data: any) => {
        // Analytics data loaded successfully
      },
      onError: (error: any) => {
        console.error("Error loading analytics:", error);
      },
    }
  );

  // Fetch availability data based on view mode - only when users are selected
  const { data: availabilityData, isLoading: isLoadingAvailability } = trpc.useQuery(
    [
      "viewer.admin.availability.getMultiUserAvailability",
      {
        userIds: selectedUsers,
        dateFrom: selectedDate.startOf("month").format("YYYY-MM-DD"),
        dateTo: selectedDate.endOf("month").format("YYYY-MM-DD"),
        includeEventDetails: true,
      },
    ],
    {
      enabled: selectedUsers.length > 0, // Only fetch when users are selected
      // Add refetch interval to ensure we get the latest data
      refetchInterval: false,
      // Add cache time to prevent stale data
      cacheTime: 5 * 60 * 1000, // 5 minutes
      onSuccess: (data: any) => {
        // Availability data loaded successfully
      },
      onError: (error: any) => {
        console.error("Error loading availability:", error);
      },
    }
  );

  function getCategoryColor(category: string) {
    switch (category) {
      case "external_meeting":
        return "bg-red-100 text-red-800 border-red-200";
      case "internal_meeting":
        return "bg-blue-100 text-blue-800 border-blue-200";
      case "self_blocked":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "unknown":
        return "bg-gray-100 text-gray-800 border-gray-200";
      default:
        return "bg-gray-100 text-gray-800 border-gray-200";
    }
  }

  function getCategoryIcon(category: string) {
    switch (category) {
      case "external_meeting":
        return Icon.FiUsers;
      case "internal_meeting":
        return Icon.FiUsers;
      case "self_blocked":
        return Icon.FiClock;
      case "unknown":
        return Icon.FiHelpCircle;
      default:
        return Icon.FiHelpCircle;
    }
  }

  function getCategoryLabel(category: string) {
    switch (category) {
      case "external_meeting":
        return "External Meeting";
      case "internal_meeting":
        return "Internal Meeting";
      case "self_blocked":
        return "Self Blocked";
      case "unknown":
        return "Unknown";
      default:
        return "Unknown";
    }
  }

  // Get busy times for a specific day
  function getBusyTimesForDay(userAvailability: any, day: dayjs.Dayjs) {
    if (!userAvailability.categorizedBusyTimes) return [];

    return userAvailability.categorizedBusyTimes.filter((busyTime: any) => {
      const busyDate = dayjs(busyTime.start);
      return busyDate.isSame(day, "day");
    });
  }

  if (isLoadingUsers) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <Icon.FiLoader className="mx-auto h-8 w-8 animate-spin text-gray-400" />
          <p className="mt-2 text-sm text-gray-500">Loading users...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* User Selection */}
      <div className="rounded-lg border bg-white p-6">
        <h3 className="mb-4 text-lg font-medium text-gray-900">Select Users</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {allUsers.map((user) => (
            <div
              key={user.id}
              className={`flex cursor-pointer items-center space-x-3 rounded-lg border p-3 transition-colors ${
                selectedUsers.includes(user.id)
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-200 hover:border-gray-300"
              }`}
              onClick={() => {
                if (selectedUsers.includes(user.id)) {
                  setSelectedUsers(selectedUsers.filter((id) => id !== user.id));
                } else {
                  setSelectedUsers([...selectedUsers, user.id]);
                }
              }}>
              <Avatar imageSrc={user.avatar} alt={user.name || user.email} size={24} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">{user.name || user.email}</p>
                <p className="truncate text-xs text-gray-500">{user.email}</p>
              </div>
              <input
                type="checkbox"
                checked={selectedUsers.includes(user.id)}
                onChange={(e) => e.preventDefault()} // Handled by onClick
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between">
          <Button color="secondary" onClick={() => setSelectedUsers(allUsers.map((u) => u.id))}>
            Select All
          </Button>
          <Button color="secondary" onClick={() => setSelectedUsers([])}>
            Clear Selection
          </Button>
        </div>
      </div>

      {/* Date Navigation */}
      <div className="rounded-lg border bg-white p-6">
        <div className="flex items-center justify-center">
          <div className="flex items-center space-x-4">
            <Button
              color="secondary"
              onClick={() => {
                const newDate = selectedDate.subtract(1, "month");
                setSelectedDate(newDate);
                setSelectedDayForCalendar(null); // Clear calendar details when month changes
              }}>
              <Icon.FiChevronLeft className="h-4 w-4" />
            </Button>
            <div className="text-center">
              <h3 className="text-lg font-medium text-gray-900">{selectedDate.format("MMMM YYYY")}</h3>
            </div>
            <Button
              color="secondary"
              onClick={() => {
                const newDate = selectedDate.add(1, "month");
                setSelectedDate(newDate);
                setSelectedDayForCalendar(null); // Clear calendar details when month changes
              }}>
              <Icon.FiChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* No Users Selected Message */}
      {selectedUsers.length === 0 && (
        <div className="rounded-lg border bg-white p-8">
          <div className="text-center">
            <Icon.FiUsers className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">No users selected</h3>
            <p className="mt-1 text-sm text-gray-500">
              Select one or more users above to view their availability.
            </p>
          </div>
        </div>
      )}

      {/* Availability Display */}
      {selectedUsers.length > 0 && isLoadingAvailability ? (
        <div className="flex items-center justify-center p-8">
          <div className="text-center">
            <Icon.FiLoader className="mx-auto h-8 w-8 animate-spin text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">Loading availability...</p>
          </div>
        </div>
      ) : (
        selectedUsers.length > 0 && (
          <div className="space-y-6">
            {availabilityData?.map((userAvailability: any) => (
              <div key={userAvailability.userId} className="rounded-lg border bg-white p-6">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <Avatar
                      imageSrc={userAvailability.user?.avatar}
                      alt={userAvailability.user?.name || userAvailability.user?.email}
                      size={32}
                    />
                    <div>
                      <h3 className="text-lg font-medium text-gray-900">
                        {userAvailability.user?.name || userAvailability.user?.email}
                      </h3>
                      <div className="flex items-center space-x-2">
                        <p className="text-sm text-gray-500">
                          {userAvailability.user?.email} •{" "}
                          {userAvailability.availability?.timeZone || userAvailability.user?.timeZone}
                        </p>
                        <button
                          onClick={() =>
                            setExpandedAvailability((prev) => ({
                              ...prev,
                              [userAvailability.userId]: !prev[userAvailability.userId],
                            }))
                          }
                          className="text-xs text-blue-600 underline hover:text-blue-800">
                          See availability
                        </button>
                      </div>
                    </div>
                  </div>
                  {userAvailability.error && (
                    <Alert severity="error" title="Error" message={userAvailability.error} />
                  )}
                </div>

                {/* Availability Schedule Display */}
                {expandedAvailability[userAvailability.userId] && (
                  <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h5 className="text-sm font-medium text-blue-800">Availability Schedule</h5>
                      <button
                        onClick={() =>
                          setExpandedAvailability((prev) => ({
                            ...prev,
                            [userAvailability.userId]: false,
                          }))
                        }
                        className="text-blue-600 hover:text-blue-800">
                        <Icon.FiX className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="space-y-2">
                      {userAvailability.availability?.workingHours ? (
                        formatAvailabilitySchedule(
                          userAvailability.availability.workingHours,
                          userAvailability.availability?.timeZone || userAvailability.user?.timeZone
                        ).map((schedule: string, index: number) => (
                          <div
                            key={index}
                            className="rounded border border-blue-200 bg-white p-2 text-sm text-blue-700">
                            {schedule}
                          </div>
                        ))
                      ) : (
                        <div className="rounded border border-blue-200 bg-white p-2 text-sm text-blue-700">
                          No availability configured
                        </div>
                      )}
                      <div className="mt-2 text-xs text-blue-600">
                        Schedule timezone:{" "}
                        {userAvailability.availability?.timeZone || userAvailability.user?.timeZone}
                      </div>
                    </div>
                  </div>
                )}

                {/* Analytics Section */}
                <div className="mt-6 space-y-4">
                  <h4 className="text-sm font-medium text-gray-700">Availability Analytics</h4>

                  {/* Calculate analytics if not provided by backend */}
                  {(() => {
                    // Use analyticsData for analytics, fallback to availabilityData
                    const analyticsUserData = analyticsData?.find(
                      (data: any) => data.userId === userAvailability.userId
                    );
                    const analytics = analyticsUserData?.analytics || userAvailability.analytics;

                    if (!analytics) {
                      return (
                        <div className="rounded-lg bg-yellow-50 p-4">
                          <div className="flex items-center">
                            <div className="text-2xl">⚠️</div>
                            <div className="ml-3">
                              <p className="text-sm font-medium text-yellow-800">
                                Availability Not Configured
                              </p>
                              <p className="text-xs text-yellow-700">
                                This user needs to configure their availability settings in Cal.com to see
                                analytics.
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <>
                        {/* Summary Cards */}
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <div className="rounded-lg bg-blue-50 p-4">
                            <div className="flex items-center">
                              <div className="text-2xl">⏰</div>
                              <div className="ml-3">
                                <p className="text-sm text-blue-600">Working Hours</p>
                                <p className="text-lg font-semibold text-blue-900">
                                  {Math.floor(analytics.totalWorkingHours)}h{" "}
                                  {Math.round((analytics.totalWorkingHours % 1) * 60)}m
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="rounded-lg bg-purple-50 p-4">
                            <div className="flex items-center">
                              <div className="text-2xl">👥</div>
                              <div className="ml-3">
                                <p className="text-sm text-purple-600">Internal Meetings</p>
                                <p className="text-lg font-semibold text-purple-900">
                                  {Math.floor(analytics.categoryStats.internal_meeting.hours)}h{" "}
                                  {Math.round((analytics.categoryStats.internal_meeting.hours % 1) * 60)}m
                                </p>
                                <div className="space-y-0.5 text-xs text-purple-600">
                                  <p>{analytics.categoryStats.internal_meeting.count} meetings</p>
                                  {analytics.categoryStats.internal_meeting.hoursInWorkingTime !==
                                    undefined && (
                                    <>
                                      <p className="flex items-center">
                                        <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-green-500" />
                                        Work hours:{" "}
                                        {Math.floor(
                                          analytics.categoryStats.internal_meeting.hoursInWorkingTime
                                        )}
                                        h{" "}
                                        {Math.round(
                                          (analytics.categoryStats.internal_meeting.hoursInWorkingTime % 1) *
                                            60
                                        )}
                                        m
                                      </p>
                                      {analytics.categoryStats.internal_meeting.hoursOutsideWorkingTime >
                                        0 && (
                                        <p className="flex items-center">
                                          <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-red-500" />
                                          After hours:{" "}
                                          {Math.floor(
                                            analytics.categoryStats.internal_meeting.hoursOutsideWorkingTime
                                          )}
                                          h{" "}
                                          {Math.round(
                                            (analytics.categoryStats.internal_meeting
                                              .hoursOutsideWorkingTime %
                                              1) *
                                              60
                                          )}
                                          m
                                        </p>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="rounded-lg bg-orange-50 p-4">
                            <div className="flex items-center">
                              <div className="text-2xl">🤝</div>
                              <div className="ml-3">
                                <p className="text-sm text-orange-600">External Meetings</p>
                                <p className="text-lg font-semibold text-orange-900">
                                  {Math.floor(analytics.categoryStats.external_meeting.hours)}h{" "}
                                  {Math.round((analytics.categoryStats.external_meeting.hours % 1) * 60)}m
                                </p>
                                <div className="space-y-0.5 text-xs text-orange-600">
                                  <p>{analytics.categoryStats.external_meeting.count} meetings</p>
                                  {analytics.categoryStats.external_meeting.hoursInWorkingTime !==
                                    undefined && (
                                    <>
                                      <p className="flex items-center">
                                        <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-green-500" />
                                        Work hours:{" "}
                                        {Math.floor(
                                          analytics.categoryStats.external_meeting.hoursInWorkingTime
                                        )}
                                        h{" "}
                                        {Math.round(
                                          (analytics.categoryStats.external_meeting.hoursInWorkingTime % 1) *
                                            60
                                        )}
                                        m
                                      </p>
                                      {analytics.categoryStats.external_meeting.hoursOutsideWorkingTime >
                                        0 && (
                                        <p className="flex items-center">
                                          <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-red-500" />
                                          After hours:{" "}
                                          {Math.floor(
                                            analytics.categoryStats.external_meeting.hoursOutsideWorkingTime
                                          )}
                                          h{" "}
                                          {Math.round(
                                            (analytics.categoryStats.external_meeting
                                              .hoursOutsideWorkingTime %
                                              1) *
                                              60
                                          )}
                                          m
                                        </p>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="rounded-lg bg-yellow-50 p-4">
                            <div className="flex items-center">
                              <div className="text-2xl">🔒</div>
                              <div className="ml-3">
                                <p className="text-sm text-yellow-600">Self Blocked (Working Hours Only)</p>
                                <p className="text-lg font-semibold text-yellow-900">
                                  {Math.floor(analytics.categoryStats.self_blocked.hoursInWorkingTime || 0)}h{" "}
                                  {Math.round(
                                    ((analytics.categoryStats.self_blocked.hoursInWorkingTime || 0) % 1) * 60
                                  )}
                                  m
                                </p>
                                <div className="space-y-0.5 text-xs text-yellow-600">
                                  <p>{analytics.categoryStats.self_blocked.count} events during work hours</p>
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="rounded-lg bg-red-50 p-4">
                            <div className="flex items-center">
                              <div className="text-2xl">🌙</div>
                              <div className="ml-3">
                                <p className="text-sm text-red-600">Outside Working Hours</p>
                                <p className="text-lg font-semibold text-red-900">
                                  {Math.floor(analytics.busyTimeOutsideWorkingHours)}h{" "}
                                  {Math.round((analytics.busyTimeOutsideWorkingHours % 1) * 60)}m
                                </p>
                                <p className="text-xs text-red-600">
                                  {analytics.meetingsOutsideWorkingHours.length} meetings (excludes personal
                                  time)
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="rounded-lg bg-green-50 p-4">
                            <div className="flex items-center">
                              <div className="text-2xl">📅</div>
                              <div className="ml-3">
                                <p className="text-sm text-green-600">Available for External</p>
                                <p className="text-lg font-semibold text-green-900">
                                  {Math.floor(analytics.availableTimeForExternalMeetings)}h{" "}
                                  {Math.round((analytics.availableTimeForExternalMeetings % 1) * 60)}m
                                </p>
                                <p className="text-xs text-green-600">free time</p>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Meetings Outside Working Hours */}
                        {analytics.meetingsOutsideWorkingHours.length > 0 && (
                          <div className="rounded-lg bg-red-50 p-4">
                            <button
                              onClick={() => setIsOutsideHoursExpanded(!isOutsideHoursExpanded)}
                              className="flex w-full items-center justify-between text-left">
                              <h5 className="text-sm font-medium text-red-700">
                                Meetings Outside Working Hours ({analytics.meetingsOutsideWorkingHours.length}{" "}
                                meetings - excludes personal time)
                              </h5>
                              <Icon.FiChevronDown
                                className={`h-4 w-4 text-red-700 transition-transform ${
                                  isOutsideHoursExpanded ? "rotate-180" : ""
                                }`}
                              />
                            </button>

                            {isOutsideHoursExpanded && (
                              <>
                                <div className="mt-3 max-h-60 space-y-2 overflow-y-auto">
                                  {analytics.meetingsOutsideWorkingHours.map(
                                    (meeting: any, index: number) => {
                                      const startDate = dayjs(meeting.start);
                                      const endDate = dayjs(meeting.end);
                                      const dayNames = [
                                        "Sunday",
                                        "Monday",
                                        "Tuesday",
                                        "Wednesday",
                                        "Thursday",
                                        "Friday",
                                        "Saturday",
                                      ];

                                      return (
                                        <div
                                          key={index}
                                          className="flex items-center justify-between rounded border border-red-200 bg-white p-2">
                                          <div className="flex-1">
                                            <div className="flex items-center space-x-2">
                                              <div
                                                className={`h-2 w-2 rounded-full ${
                                                  getCategoryColor(meeting.category).split(" ")[0]
                                                }`}
                                              />
                                              <span className="truncate text-sm font-medium text-gray-900">
                                                {meeting.title}
                                              </span>
                                            </div>
                                            <div className="mt-1 text-xs text-gray-500">
                                              {dayNames[meeting.dayOfWeek]} • {startDate.format("HH:mm")} -{" "}
                                              {endDate.format("HH:mm")} • {Math.floor(meeting.duration)}h{" "}
                                              {Math.round((meeting.duration % 1) * 60)}m
                                            </div>
                                          </div>
                                          <div className="text-xs font-medium text-red-600">
                                            {getCategoryLabel(meeting.category)}
                                          </div>
                                        </div>
                                      );
                                    }
                                  )}
                                </div>
                                <div className="mt-3 text-xs text-red-600">
                                  Total: {analytics.meetingsOutsideWorkingHours.length} meetings (
                                  {Math.floor(analytics.busyTimeOutsideWorkingHours)}h{" "}
                                  {Math.round((analytics.busyTimeOutsideWorkingHours % 1) * 60)}m)
                                </div>
                              </>
                            )}
                          </div>
                        )}

                        {/* Sales Analytics Section */}
                        {analytics.salesAnalytics && (
                          <>
                            {/* Availability Health Status */}
                            <div
                              className={`cursor-help rounded-lg border-2 p-4 ${
                                analytics.salesAnalytics.healthStatus.status === "healthy"
                                  ? "border-green-200 bg-green-50"
                                  : analytics.salesAnalytics.healthStatus.status === "warning"
                                  ? "border-yellow-200 bg-yellow-50"
                                  : "border-red-200 bg-red-50"
                              }`}
                              title={`External Meeting Capacity Calculation:
• Total Working Hours: ${analytics.totalWorkingHours.toFixed(1)}h
• Available for External Meetings: ${analytics.availableTimeForExternalMeetings.toFixed(1)}h
• Already Booked External Meetings (in work hours): ${
                                analytics.categoryStats.external_meeting.hoursInWorkingTime?.toFixed(1) ||
                                "0.0"
                              }h
• Total External Meeting Capacity: ${(
                                analytics.availableTimeForExternalMeetings +
                                (analytics.categoryStats.external_meeting.hoursInWorkingTime || 0)
                              ).toFixed(1)}h
• Calculation: (${(
                                analytics.availableTimeForExternalMeetings +
                                (analytics.categoryStats.external_meeting.hoursInWorkingTime || 0)
                              ).toFixed(1)}h ÷ ${analytics.totalWorkingHours.toFixed(
                                1
                              )}h) × 100 = ${analytics.salesAnalytics.healthStatus.availabilityPercentage.toFixed(
                                1
                              )}%

This shows the percentage of working hours that can be used for external meetings (both available time + already scheduled external meetings).

Thresholds:
• 50%+ = Healthy (green)
• 30-49% = Warning (yellow)
• <30% = Critical (red)`}>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-3">
                                  <div className="text-3xl">
                                    {analytics.salesAnalytics.healthStatus.color}
                                  </div>
                                  <div>
                                    <h5
                                      className={`text-lg font-bold ${
                                        analytics.salesAnalytics.healthStatus.status === "healthy"
                                          ? "text-green-800"
                                          : analytics.salesAnalytics.healthStatus.status === "warning"
                                          ? "text-yellow-800"
                                          : "text-red-800"
                                      }`}>
                                      {analytics.salesAnalytics.healthStatus.label}
                                    </h5>
                                    <p
                                      className={`text-sm ${
                                        analytics.salesAnalytics.healthStatus.status === "healthy"
                                          ? "text-green-600"
                                          : analytics.salesAnalytics.healthStatus.status === "warning"
                                          ? "text-yellow-600"
                                          : "text-red-600"
                                      }`}>
                                      {analytics.salesAnalytics.healthStatus.message}
                                    </p>
                                  </div>
                                </div>
                                <div className="text-right">
                                  <div
                                    className={`text-2xl font-bold ${
                                      analytics.salesAnalytics.healthStatus.status === "healthy"
                                        ? "text-green-800"
                                        : analytics.salesAnalytics.healthStatus.status === "warning"
                                        ? "text-yellow-800"
                                        : "text-red-800"
                                    }`}>
                                    {analytics.salesAnalytics.healthStatus.percentage.toFixed(1)}%
                                  </div>
                                  <div
                                    className={`text-xs ${
                                      analytics.salesAnalytics.healthStatus.status === "healthy"
                                        ? "text-green-600"
                                        : analytics.salesAnalytics.healthStatus.status === "warning"
                                        ? "text-yellow-600"
                                        : "text-red-600"
                                    }`}>
                                    {Math.floor(analytics.availableTimeForExternalMeetings)}h{" "}
                                    {Math.round((analytics.availableTimeForExternalMeetings % 1) * 60)}m +{" "}
                                    {Math.floor(
                                      analytics.categoryStats.external_meeting.hoursInWorkingTime || 0
                                    )}
                                    h{" "}
                                    {Math.round(
                                      ((analytics.categoryStats.external_meeting.hoursInWorkingTime || 0) %
                                        1) *
                                        60
                                    )}
                                    m
                                  </div>
                                  <div
                                    className={`text-xs ${
                                      analytics.salesAnalytics.healthStatus.status === "healthy"
                                        ? "text-green-600"
                                        : analytics.salesAnalytics.healthStatus.status === "warning"
                                        ? "text-yellow-600"
                                        : "text-red-600"
                                    }`}>
                                    Available + Booked
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Daily Availability Breakdown */}
                            <div className="rounded-lg bg-gray-50 p-4">
                              <h5 className="mb-3 text-sm font-medium text-gray-700">
                                Daily Availability Patterns
                              </h5>
                              <div className="overflow-x-auto">
                                <table className="min-w-full">
                                  <thead>
                                    <tr className="text-xs uppercase tracking-wider text-gray-500">
                                      <th className="px-3 py-2 text-left">Day & Date</th>
                                      <th className="px-3 py-2 text-center">Working Hours</th>
                                      <th className="px-3 py-2 text-center">Available Hours</th>
                                      <th className="px-3 py-2 text-center">Availability %</th>
                                      <th className="px-3 py-2 text-center">
                                        External
                                        <br />
                                        <span className="text-xs font-normal text-gray-400">
                                          (count / work hrs / after hrs)
                                        </span>
                                      </th>
                                      <th className="px-3 py-2 text-center">
                                        Internal
                                        <br />
                                        <span className="text-xs font-normal text-gray-400">
                                          (count / work hrs / after hrs)
                                        </span>
                                      </th>
                                      <th className="px-3 py-2 text-center">
                                        Self-Blocked
                                        <br />
                                        <span className="text-xs font-normal text-gray-400">
                                          (count / work hrs / after hrs)
                                        </span>
                                      </th>
                                      <th className="px-3 py-2 text-center">
                                        Outside Work Hours
                                        <br />
                                        <span className="text-xs font-normal text-gray-400">
                                          (excludes personal time)
                                        </span>
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-200">
                                    {analytics.salesAnalytics.dailyBreakdown.map(
                                      (day: any, index: number) => {
                                        const isNonWorkingDay = day.workingHours === 0;
                                        const selectedDay = dayjs(day.date);
                                        const isCalendarOpen = selectedDayForCalendar?.isSame(
                                          selectedDay,
                                          "day"
                                        );

                                        return (
                                          <React.Fragment key={index}>
                                            <tr
                                              className={`text-sm ${
                                                isNonWorkingDay
                                                  ? "bg-gray-100 text-gray-500"
                                                  : day.availabilityPercentage < 40
                                                  ? "bg-red-50"
                                                  : day.availabilityPercentage < 60
                                                  ? "bg-yellow-50"
                                                  : "bg-white"
                                              }`}>
                                              <td className="px-3 py-2 font-medium text-gray-900">
                                                <div
                                                  className="-m-1 flex cursor-pointer flex-col rounded p-1 hover:bg-blue-50"
                                                  onClick={() => {
                                                    setSelectedDayForCalendar(
                                                      isCalendarOpen ? null : selectedDay
                                                    );
                                                  }}>
                                                  <span className="font-semibold text-blue-600 hover:text-blue-800">
                                                    {day.day}
                                                  </span>
                                                  <span className="text-xs text-gray-500">
                                                    {dayjs(day.date).format("MMM D, YYYY")}
                                                  </span>
                                                </div>
                                              </td>
                                              <td className="px-3 py-2 text-center text-gray-600">
                                                {formatHoursMinutes(day.workingHours)}
                                              </td>
                                              <td className="px-3 py-2 text-center text-gray-900">
                                                {formatHoursMinutes(day.availableHours)}
                                              </td>
                                              <td className="px-3 py-2 text-center">
                                                <span
                                                  className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                                                    day.availabilityPercentage >= 70
                                                      ? "bg-green-100 text-green-800"
                                                      : day.availabilityPercentage >= 40
                                                      ? "bg-yellow-100 text-yellow-800"
                                                      : "bg-red-100 text-red-800"
                                                  }`}>
                                                  {day.availabilityPercentage.toFixed(0)}%
                                                </span>
                                              </td>
                                              <td className="px-3 py-2 text-center text-blue-600">
                                                <div className="flex flex-col">
                                                  <span className="font-semibold">
                                                    {day.externalMeetings}
                                                  </span>
                                                  {(day.externalHoursInWorkingTime || 0) +
                                                    (day.externalHoursOutsideWorkingTime || 0) >
                                                    0 && (
                                                    <div className="text-xs">
                                                      {(day.externalHoursInWorkingTime || 0) > 0 && (
                                                        <div className="flex items-center justify-center space-x-1">
                                                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                                                          <span className="text-gray-700">
                                                            {formatHoursMinutes(
                                                              day.externalHoursInWorkingTime
                                                            )}
                                                          </span>
                                                        </div>
                                                      )}
                                                      {(day.externalHoursOutsideWorkingTime || 0) > 0 && (
                                                        <div className="flex items-center justify-center space-x-1">
                                                          <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                                                          <span className="text-gray-500">
                                                            {formatHoursMinutes(
                                                              day.externalHoursOutsideWorkingTime
                                                            )}
                                                          </span>
                                                        </div>
                                                      )}
                                                    </div>
                                                  )}
                                                </div>
                                              </td>
                                              <td className="px-3 py-2 text-center text-purple-600">
                                                <div className="flex flex-col">
                                                  <span className="font-semibold">
                                                    {day.internalMeetings}
                                                  </span>
                                                  {(day.internalHoursInWorkingTime || 0) +
                                                    (day.internalHoursOutsideWorkingTime || 0) >
                                                    0 && (
                                                    <div className="text-xs">
                                                      {(day.internalHoursInWorkingTime || 0) > 0 && (
                                                        <div className="flex items-center justify-center space-x-1">
                                                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                                                          <span className="text-gray-700">
                                                            {formatHoursMinutes(
                                                              day.internalHoursInWorkingTime
                                                            )}
                                                          </span>
                                                        </div>
                                                      )}
                                                      {(day.internalHoursOutsideWorkingTime || 0) > 0 && (
                                                        <div className="flex items-center justify-center space-x-1">
                                                          <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                                                          <span className="text-gray-500">
                                                            {formatHoursMinutes(
                                                              day.internalHoursOutsideWorkingTime
                                                            )}
                                                          </span>
                                                        </div>
                                                      )}
                                                    </div>
                                                  )}
                                                </div>
                                              </td>
                                              <td className="px-3 py-2 text-center text-yellow-600">
                                                <div className="flex flex-col">
                                                  <span className="font-semibold">{day.selfBlocked}</span>
                                                  {(day.selfBlockedHoursInWorkingTime || 0) > 0 && (
                                                    <div className="text-xs">
                                                      <div className="flex items-center justify-center space-x-1">
                                                        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                                                        <span className="text-gray-700">
                                                          {formatHoursMinutes(
                                                            day.selfBlockedHoursInWorkingTime
                                                          )}
                                                        </span>
                                                      </div>
                                                    </div>
                                                  )}
                                                </div>
                                              </td>
                                              <td className="px-3 py-2 text-center text-red-600">
                                                <span className="text-sm font-medium">
                                                  {formatHoursMinutes(day.busyHoursOutsideWorkingTime || 0)}
                                                </span>
                                              </td>
                                            </tr>

                                            {/* Calendar Detail Row - appears right under the clicked date */}
                                            {isCalendarOpen && (
                                              <tr>
                                                <td colSpan={7} className="px-0 py-0">
                                                  <div className="mx-3 my-2 rounded border-l-4 border-blue-400 bg-blue-50 p-4">
                                                    <div className="mb-3 flex items-center justify-between">
                                                      <h5 className="text-sm font-medium text-blue-800">
                                                        Calendar Details -{" "}
                                                        {selectedDay.format("dddd, MMMM D, YYYY")}
                                                      </h5>
                                                      <Button
                                                        color="secondary"
                                                        size="sm"
                                                        onClick={() => setSelectedDayForCalendar(null)}>
                                                        <Icon.FiX className="h-4 w-4" />
                                                      </Button>
                                                    </div>

                                                    {(() => {
                                                      const busyTimes = getBusyTimesForDay(
                                                        userAvailability,
                                                        selectedDay
                                                      );

                                                      // Process busy times for display

                                                      if (busyTimes.length === 0) {
                                                        return (
                                                          <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                                                            <div className="flex items-center">
                                                              <Icon.FiCalendar className="h-5 w-5 text-green-600" />
                                                              <div className="ml-3">
                                                                <p className="text-sm font-medium text-green-800">
                                                                  No meetings scheduled
                                                                </p>
                                                                <p className="text-xs text-green-600">
                                                                  This day is completely free
                                                                </p>
                                                              </div>
                                                            </div>
                                                          </div>
                                                        );
                                                      }

                                                      return (
                                                        <div className="space-y-2">
                                                          {busyTimes.map(
                                                            (busyTime: any, busyIndex: number) => {
                                                              const CategoryIcon = getCategoryIcon(
                                                                busyTime.category
                                                              );
                                                              const isGoogleCalendar =
                                                                busyTime.source?.includes(
                                                                  "google_calendar"
                                                                ) ||
                                                                busyTime.source?.includes("googlecalendar");
                                                              const isCalBooking =
                                                                busyTime.source?.includes("eventType-") ||
                                                                busyTime.source?.includes("booking-");

                                                              return (
                                                                <div
                                                                  key={busyIndex}
                                                                  className={`flex items-start justify-between rounded-lg border bg-white p-3 ${getCategoryColor(
                                                                    busyTime.category
                                                                  )
                                                                    .replace("bg-", "border-")
                                                                    .replace("-100", "-200")}`}>
                                                                  <div className="flex items-start space-x-3">
                                                                    <CategoryIcon className="mt-1 h-4 w-4" />
                                                                    <div className="flex-1">
                                                                      <div className="mb-1 flex items-center space-x-2">
                                                                        {isGoogleCalendar && (
                                                                          <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                                                                            Google Calendar
                                                                          </span>
                                                                        )}
                                                                        {isCalBooking && (
                                                                          <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                                                                            Cal.com Booking
                                                                          </span>
                                                                        )}
                                                                        <span
                                                                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getCategoryColor(
                                                                            busyTime.category
                                                                          )}`}>
                                                                          {getCategoryLabel(
                                                                            busyTime.category
                                                                          )}
                                                                        </span>
                                                                      </div>
                                                                      <p className="mb-1 text-sm font-semibold text-gray-900">
                                                                        {busyTime.eventTitle ||
                                                                          busyTime.title ||
                                                                          busyTime.summary ||
                                                                          getCategoryLabel(busyTime.category)}
                                                                      </p>
                                                                      <p className="text-xs text-gray-600">
                                                                        {dayjs(busyTime.start).format(
                                                                          "h:mm A"
                                                                        )}{" "}
                                                                        -{" "}
                                                                        {dayjs(busyTime.end).format("h:mm A")}
                                                                      </p>
                                                                      {busyTime.attendees &&
                                                                        busyTime.attendees.length > 0 && (
                                                                          <p className="mt-1 text-xs text-gray-500">
                                                                            Attendees:{" "}
                                                                            {busyTime.attendees
                                                                              .slice(0, 3)
                                                                              .join(", ")}
                                                                            {busyTime.attendees.length > 3 &&
                                                                              ` +${
                                                                                busyTime.attendees.length - 3
                                                                              } more`}
                                                                          </p>
                                                                        )}
                                                                    </div>
                                                                  </div>
                                                                  <div className="text-right">
                                                                    <p className="text-xs font-medium text-gray-900">
                                                                      {dayjs(busyTime.end).diff(
                                                                        dayjs(busyTime.start),
                                                                        "minute"
                                                                      )}{" "}
                                                                      min
                                                                    </p>
                                                                    <p className="text-xs text-gray-500">
                                                                      {formatHoursMinutes(
                                                                        dayjs(busyTime.end).diff(
                                                                          dayjs(busyTime.start),
                                                                          "hour",
                                                                          true
                                                                        )
                                                                      )}
                                                                    </p>
                                                                  </div>
                                                                </div>
                                                              );
                                                            }
                                                          )}
                                                        </div>
                                                      );
                                                    })()}
                                                  </div>
                                                </td>
                                              </tr>
                                            )}
                                          </React.Fragment>
                                        );
                                      }
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            </div>

                            {/* Red Flags & Insights */}
                            {(analytics.salesAnalytics.redFlags.length > 0 ||
                              analytics.salesAnalytics.insights.length > 0) && (
                              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                                {/* Red Flags */}
                                {analytics.salesAnalytics.redFlags.length > 0 && (
                                  <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                                    <h5 className="mb-3 flex items-center text-sm font-medium text-red-700">
                                      <span className="mr-2">🚨</span>
                                      Availability Concerns
                                    </h5>
                                    <div className="space-y-2">
                                      {analytics.salesAnalytics.redFlags.map(
                                        (flag: string, index: number) => (
                                          <div
                                            key={index}
                                            className="rounded border border-red-200 bg-white p-2 text-sm text-red-700">
                                            {flag}
                                          </div>
                                        )
                                      )}
                                    </div>
                                  </div>
                                )}

                                {/* Insights */}
                                {analytics.salesAnalytics.insights.length > 0 && (
                                  <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                                    <h5 className="mb-3 flex items-center text-sm font-medium text-blue-700">
                                      <span className="mr-2">💡</span>
                                      Key Insights
                                    </h5>
                                    <div className="space-y-2">
                                      {analytics.salesAnalytics.insights.map(
                                        (insight: string, index: number) => (
                                          <div
                                            key={index}
                                            className="rounded border border-blue-200 bg-white p-2 text-sm text-blue-700">
                                            {insight}
                                          </div>
                                        )
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
