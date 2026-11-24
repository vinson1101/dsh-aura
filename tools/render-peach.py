"""Bake the Aura test character using an external checkout of LivePortrait (9b294b3).
Usage: PYTHONPATH=/path/to/LivePortrait python tools/render-peach.py /path/to/verified/human/weights
Dependencies: upstream LivePortrait human inference, numpy, Pillow and OpenCV.
The manual crop is calibrated to outfit-peach-check.png (1024 x 1536).
"""
import math
from pathlib import Path
import sys

import cv2
import numpy as np
import torch
from PIL import Image
from src.config.inference_config import InferenceConfig
from src.live_portrait_wrapper import LivePortraitWrapper
from src.utils.camera import get_rotation_matrix

root = Path(__file__).resolve().parents[1]
out = root / 'assets/runtime/peach'
out.mkdir(parents=True, exist_ok=True)
weights = Path(sys.argv[1])
cfg = InferenceConfig(flag_use_half_precision=False)
for key in ('F', 'M', 'G', 'W', 'S'):
    attr = 'checkpoint_' + key
    setattr(cfg, attr, str(weights / Path(getattr(cfg, attr)).name))
model = LivePortraitWrapper(cfg)
original = np.asarray(Image.open(root / 'assets/characters/outfit-peach-check.png').convert('RGB'))
assert original.shape == (1536, 1024, 3)
Image.fromarray(original).resize((640, 960), Image.Resampling.LANCZOS).save(out / 'portrait.webp', quality=94)
crop = original[150:830, 190:870]
source = model.prepare_source(crop)
info = model.get_kp_info(source)
features = model.extract_feature_3d(source)
keys = model.transform_keypoint(info)
tensor = lambda values: torch.tensor([values], device=model.device, dtype=torch.float32)
# Keep the learned delta relative to the neutral pose, including at clip boundaries.
def eye_at(ratio):
    return model.retarget_eye(keys, tensor([0.24, 0.24, ratio]))
def lip_at(ratio):
    return model.retarget_lip(keys, tensor([0.02, ratio]))
blink_delta = eye_at(0.0) - eye_at(0.24)
open_delta = lip_at(0.5) - lip_at(0.02)

def render(pitch=0., yaw=0., roll=0., blink=0., wink=0., smile=0., gaze=0., jaw=0., shape=0):
    exp = info['exp'].clone()
    # Semantic expression controls from LivePortrait's human retargeting editor.
    exp[0, 11, 0] += gaze * .0007
    exp[0, 15, 0] += gaze * .001
    exp[0, 11, 1] += wink * .023
    exp[0, 13, 1] -= wink * .0069
    for k, dy in [(20,-.01),(14,-.02),(17,.0065),(13,-.00275),(16,-.00275),(3,-.0035),(7,-.0035)]:
        exp[0,k,1] += smile*dy
    exp[0,17,2] += smile*.003
    if shape == 1:  # narrow, forward lips
        exp[0,19,2] += jaw*.016
        exp[0,20,2] += jaw*.011
    if shape == 2:  # wider corners
        exp[0,14,1] -= jaw*.012
        exp[0,17,2] -= jaw*.009
    rot = get_rotation_matrix(info['pitch']+pitch, info['yaw']+yaw, info['roll']+roll)
    target = info['scale'][...,None]*(info['kp'] @ rot + exp)
    target[:,:,:2] += info['t'][:,None,:2]
    target = model.stitching(keys, target + blink*blink_delta + jaw*open_delta)
    rgb = model.parse_output(model.warp_decode(features, keys, target)['out'])[0]
    return cv2.resize(rgb, (288,288), interpolation=cv2.INTER_AREA).astype(np.float32)

base = render()
reference = cv2.resize(crop,(288,288),interpolation=cv2.INTER_AREA).astype(np.float32)
color_offset = cv2.GaussianBlur(reference-base, (0, 0), 14)
y,x=np.mgrid[:288,:288]
edge=np.minimum.reduce([x,y,287-x,287-y])
mask=np.clip(edge/25.,0,1)[...,None]
atlas=Image.new('RGB',(288*12,288*16))
groups = ['idle','listening','thinking','welcome','nod','shy','wink','talking']
for group, name in enumerate(groups):
    for i in range(24):
        t=i/23
        arc=math.sin(math.pi*t)**2
        beat=math.sin(2*math.pi*t)*arc
        blink=max(0,1-abs(i-15)/1.6)
        poses = {
            'idle': dict(yaw=1.3*beat,pitch=.8*arc,blink=blink),
            'listening': dict(roll=3*arc,pitch=2*arc,yaw=1.8*beat,blink=.8*blink),
            'thinking': dict(yaw=-5*arc,pitch=-3*arc,gaze=-6*arc,blink=blink),
            'welcome': dict(yaw=3*beat,roll=-3*arc,smile=.85*arc),
            'nod': dict(pitch=7*math.sin(2*math.pi*t)**2*arc,smile=.3*arc),
            'shy': dict(pitch=6*arc,yaw=-6*arc,roll=3*arc,smile=.68*arc,blink=.7*arc),
            'wink': dict(roll=-4*arc,wink=arc,smile=.7*arc),
            'talking': dict(jaw=(i%8)/7,shape=i//8),
        }
        frame = render(**poses[name])
        # Preserve illumination while letting moving eyelids and lips replace source texture.
        rgb = reference * (1-mask) + (frame+color_offset)*mask
        tile=Image.fromarray(np.clip(rgb,0,255).astype('uint8'))
        n=group*24+i
        atlas.paste(tile,((n%12)*288,(n//12)*288))
    print('rendered',name,flush=True)
atlas.save(out/'motion.webp',quality=91,method=4)
