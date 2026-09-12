from pathlib import Path
from PIL import Image, ImageChops
import os, subprocess, json

root = Path(__file__).resolve().parents[1]
repo = root.parents[1]
bin_dir = repo / 'output/lecue-youtube-ad-us-v3/video/node_modules/@remotion/compositor-darwin-arm64'
env = dict(os.environ, DYLD_LIBRARY_PATH=str(bin_dir))
ffmpeg = str(bin_dir / 'ffmpeg')
source = root / 'reference-originals/04-user-interaction.mov'
target = root / 'assets/04-interaction-cursor-hidden.mp4'
w, h = 3248, 2000
crop = (576, 462, 3136, 1758)
out_w, out_h = crop[2]-crop[0], crop[3]-crop[1]
frames_dir = root / 'inspection/video-frames'
clean_dir = root / 'inspection/clean-frames'
frames_dir.mkdir(exist_ok=True)
clean_dir.mkdir(exist_ok=True)
subprocess.run([ffmpeg,'-y','-v','error','-i',str(source),'-r','30',str(frames_dir/'%04d.png')],env=env,check=True)
audit=[]
frame=0
for filename in sorted(frames_dir.glob('*.png')):
    im=Image.open(filename).convert('RGB')
    roi=(1120,570,3020,1758)
    region=im.crop(roi)
    r,g,b=region.split()
    mask=ImageChops.lighter(ImageChops.lighter(r,g),b).point(lambda v:255 if v<10 else 0)
    bb=mask.getbbox()
    if bb:
        x1,y1,x2,y2=bb
        if x2-x1>70 or y2-y1>90:
            raise RuntimeError(f'Ambiguous dark region at frame {frame}: {bb}')
        box=(x1+roi[0]-10,y1+roi[1]-10,x2+roi[0]+10,y2+roi[1]+10)
        # Same scanlines, neighboring flat UI/bar interior; no interpolation of type.
        donor=(box[0]+100,box[1],box[2]+100,box[3])
        im.paste(im.crop(donor),box[:2])
        audit.append({'frame':frame,'box':box})
    im.crop(crop).save(clean_dir/filename.name)
    frame+=1
subprocess.run([ffmpeg,'-y','-v','error','-framerate','30','-i',str(clean_dir/'%04d.png'),'-t','10.16','-an','-c:v','libx264','-crf','16','-pix_fmt','yuv420p','-movflags','+faststart',str(target)],env=env,check=True)
(root/'inspection/video-cleanup-audit.json').write_text(json.dumps({'frames':frame,'fps':30,'crop':crop,'patched':audit},indent=2))
print(json.dumps({'output':str(target),'frames':frame,'patched_frames':len(audit),'size':[out_w,out_h]}))
