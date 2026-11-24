#!/usr/bin/env python3
"""Local-only adapter of wan-approved-22s/run.py; no downloads or retuning.

The Host supplies private, generated paths, never browser commands. The existing
Mac environment/repository are read-only. Run in a private job working directory
with configs/latentsync/checkpoints symlinks to the verified repository.
"""
import argparse
import json
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    for name in ('audio', 'source', 'output', 'env-dir', 'vae-dir'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    import torch
    from omegaconf import OmegaConf
    from diffusers import AutoencoderKL, DDIMScheduler
    from latentsync.models.unet import UNet3DConditionModel
    from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline
    from latentsync.whisper.audio2feature import Audio2Feature
    from DeepCache import DeepCacheSDHelper

    output = Path(args.output)
    env = Path(args.env_dir)
    start = time.monotonic()
    def report(stage, **values):
        print('AURA_PROGRESS ' + json.dumps(dict(stage=stage,
              renderElapsedSeconds=round(time.monotonic() - start, 3), **values)), flush=True)

    # Same algorithm, dtype, seed, device and DeepCache settings as the verified
    # run. Only input/output locations and structured observation are different.
    torch.set_num_threads(4)
    torch.manual_seed(1247)
    config = OmegaConf.load('configs/unet/stage2_512.yaml')
    report('loading-models')
    audio = Audio2Feature(str(env / 'tiny.pt'), device='cpu', num_frames=16, audio_feat_length=[2, 2])
    vae = AutoencoderKL.from_pretrained(args.vae_dir, torch_dtype=torch.float16, local_files_only=True)
    vae.config.scaling_factor = .18215
    vae.config.shift_factor = 0
    vae.enable_slicing()
    torch.set_default_dtype(torch.float16)
    unet = UNet3DConditionModel(**OmegaConf.to_container(config.model))
    torch.set_default_dtype(torch.float32)
    weights = torch.load(env / 'latentsync_unet.pt', map_location='cpu', weights_only=True, mmap=True)
    unet.load_state_dict(weights['state_dict'], strict=True)
    del weights
    pipe = LipsyncPipeline(vae=vae, audio_encoder=audio, unet=unet,
                          scheduler=DDIMScheduler.from_pretrained('configs')).to('mps')
    helper = DeepCacheSDHelper(pipe=pipe)
    helper.set_params(cache_interval=3, cache_branch_id=0)
    helper.enable()
    torch.manual_seed(1247)
    raw_decode = pipe.decode_latents
    decoded_frames = 0
    chunk = 1
    steps_completed = 0
    def inspect_decode(latents):
        nonlocal decoded_frames, chunk
        result = raw_decode(latents)
        assert torch.isfinite(result).all(), 'Non-finite decoded face'
        decoded_frames += int(result.shape[0])
        report('rendering', decodedFrames=decoded_frames, chunk=chunk, step=20, steps=20)
        chunk += 1
        return result
    pipe.decode_latents = inspect_decode
    def progress(step, timestep, latents):
        nonlocal steps_completed
        assert torch.isfinite(latents).all(), 'Non-finite diffusion state'
        steps_completed += 1
        report('rendering', step=step + 1, steps=20, chunk=chunk,
               decodedFrames=decoded_frames, gpuGB=round(torch.mps.driver_allocated_memory() / 1e9, 2))
    report('rendering')
    pipe(video_path=args.source, audio_path=args.audio, video_out_path=str(output),
         num_frames=16, num_inference_steps=20, guidance_scale=1.5,
         weight_dtype=torch.float16, width=512, height=512,
         mask_image_path='latentsync/utils/mask.png', temp_dir=str(output.parent / 'render-temp'),
         callback=progress)
    assert decoded_frames > 0 and steps_completed > 0, 'No real finite decode evidence'
    # This is written only after the real pipeline returns successfully. Unit
    # test doubles are not generation evidence and are never used by deployment.
    (output.parent / 'render-result.json').write_text(json.dumps(dict(
        finiteDecode=True, decodedFrames=decoded_frames, stepsCompleted=steps_completed,
        seconds=time.monotonic() - start, seed=1247, steps=20, guidance=1.5,
        resolution=512, framesPerChunk=16, deepcacheInterval=3, deepcacheBranch=0,
        device='mps', vaeSlicing=True, sequentialCfg=False, mpsQueryChunk=512), indent=2))
    report('muxing', decodedFrames=decoded_frames)


if __name__ == '__main__':
    main()
