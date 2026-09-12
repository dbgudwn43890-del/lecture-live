import "./index.css";
import { Composition } from "remotion";
import { Ad15, DURATION, FPS } from "./Ad15";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Lecue15"
    component={Ad15}
    durationInFrames={DURATION}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
