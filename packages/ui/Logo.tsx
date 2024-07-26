import Lottie from "lottie-react";

import { LOGO_ICON, LOGO } from "@calcom/lib/constants";

import LogoAnimated from "./LogoAnimated.json";
import LogoAnimatedWhite from "./LogoAnimatedWhite.json";

export default function Logo({
  small,
  icon,
  animated,
}: {
  small?: boolean;
  icon?: boolean;
  animated?: boolean;
}) {
  return (
    <h1 className="logo inline">
      {animated ? (
        <div className="max-w-40">
          <span className="inline dark:hidden">
            <Lottie animationData={LogoAnimated} loop={false} />
          </span>
          <span className="hidden dark:inline">
            <Lottie animationData={LogoAnimatedWhite} loop={false} />
          </span>
        </div>
      ) : (
        <strong>
          {icon ? (
            <img className="w-22 mx-auto" alt="VWO" title="VWO" src={LOGO_ICON} />
          ) : (
            <img className={small ? "h-22 w-auto" : "h-24 w-auto"} alt="VWO" title="VWO" src={LOGO} />
          )}
        </strong>
      )}
    </h1>
  );
}
