import { useLocale } from "@calcom/lib/hooks/useLocale";
import Meta from "@calcom/ui/v2/core/Meta";
import { getLayout } from "@calcom/ui/v2/core/layouts/SettingsLayout";

const PasswordView = () => {
  const { t } = useLocale();
  return (
    <>
      <Meta title={t("password")} description={t("password_description")} />
      <p className="text-sm text-gray-600">
        Sign-in is managed by Google. Manage your password in your Google account.
      </p>
    </>
  );
};

PasswordView.getLayout = getLayout;
export default PasswordView;
