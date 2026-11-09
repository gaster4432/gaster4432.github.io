# Share Steam Deck desktop audio in Peek with Firefox

Firefox on Linux does not currently return desktop audio from its native
screen-sharing picker. Peek's **Share desktop audio** option can instead
capture a virtual recording input containing the Deck's playback sound.
This does not modify Firefox or add a checkbox to Firefox's native picker.

## On the Steam Deck

In Desktop Mode, open **Konsole** and run:

```sh
pactl load-module module-remap-source master="$(pactl get-default-sink).monitor" source_name=desktop_audio source_properties=device.description=Desktop_Audio
```

This requires `pactl` and PipeWire's PulseAudio compatibility service. It
needs no sudo and makes no permanent OS changes. If the command is missing
or reports an error, stop and use that actual error to troubleshoot—do not
unlock SteamOS's read-only filesystem or install random packages.

The command prints a module number. Keep it for the optional undo command:

```sh
pactl unload-module MODULE_NUMBER
```

Replace `MODULE_NUMBER` with the printed number, not that literal text.
The virtual input is temporary: recreate it after restarting the Deck or
its audio service. Do not repeatedly run the command if the input already
exists. If you switch outputs (speakers/headphones/HDMI), recreate it for
the new default output.

## In Peek

1. Turn on **Share desktop audio**.
2. Choose **Firefox / Steam Deck — virtual desktop input**.
3. Click **Find desktop audio input**. Firefox may request microphone
   permission so input names become visible. Peek immediately stops that
   temporary permission-check capture; it is never transmitted.
4. Explicitly select **Desktop_Audio** from **Desktop audio input**.
5. Click **Host a screen share**, select the screen/window, and send the
   resulting code to your friend.

Peek only transmits the chosen desktop/monitor input, never a physical
microphone fallback. Its host audio note states whether audio was actually
captured. Denied permission or a missing input leaves video sharing usable.
If the viewer's browser blocks playback, use **Play video / sound**.

## Important limits

- This captures playback going to the selected output. A window-only share
  can still send other applications' sound routed to that output.
- Incoming voice/video-call sound on that output can be sent back to the
  call, creating digital feedback. Headphones do not stop that loopback.
  Keep incoming calls on a different output or avoid capturing them.
- This is desktop sound, not simultaneous voice-microphone mixing.
- Stop sharing closes both screen and audio capture.
- This setup is documented but has not been verified on your particular
  Steam Deck/Firefox installation. A local synthetic audio test verifies
  Peek's transmission, not the Deck's device setup.

## Sources

- Mozilla audio sharing tracker: https://bugzilla.mozilla.org/show_bug.cgi?id=1541425
- Linux/PipeWire report (duplicate, not fixed): https://bugzilla.mozilla.org/show_bug.cgi?id=1837017
- PipeWire virtual source module: https://docs.pipewire.org/page_pulse_module_remap_source.html
- PipeWire runtime module loading: https://docs.pipewire.org/page_pulse_modules.html
