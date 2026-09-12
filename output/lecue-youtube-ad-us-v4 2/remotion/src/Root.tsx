import "./index.css";
import { Composition } from "remotion";
import { LecueAd } from "./LecueAd";

const base = { width: 1920, height: 1080, fps: 30, durationInFrames: 450 };

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="LecueAd-VO-Andrew" component={LecueAd} {...base} defaultProps={{ voice: "andrew" }} />
    <Composition id="LecueAd-VO-Ava" component={LecueAd} {...base} defaultProps={{ voice: "ava" }} />
    <Composition id="LecueAd-Mute" component={LecueAd} {...base} defaultProps={{ voice: null }} />
  </>
);
