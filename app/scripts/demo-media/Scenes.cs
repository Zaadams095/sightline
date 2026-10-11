// Renders Sightline's sample-camera footage (Demo mode). Everything is drawn here from simple
// shapes, so the media has no third-party license. Run through make-demo-media.ps1, which
// compiles this with Windows PowerShell's Add-Type (C# 5: no string interpolation or `?.`).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class DemoMedia
{
    public static string Ffmpeg = "ffmpeg";
    public const int Fps = 15;
    public const double Loop = 12.0; // live loops repeat every 12 s; ambient motion is periodic in it

    public delegate void Painter(Graphics g, double t);

    const string CamLook = "gblur=sigma=0.55,noise=alls=4:allf=t,eq=saturation=0.9:contrast=1.03";
    const string Fisheye = "lenscorrection=k1=-0.22:k2=0.04,vignette=PI/4.5";
    const string Infrared = "hue=s=0,eq=contrast=1.3:brightness=0.03,vignette=PI/3.2,gblur=sigma=0.7,noise=alls=9:allf=t";

    /// Renders every clip and still into outDir (see make-demo-media.ps1).
    public static void Build(string outDir, int crf)
    {
        Directory.CreateDirectory(outDir);
        var fd = new FrontDoor();
        Clip(outDir, "front-door", FrontDoor.W, FrontDoor.H, fd.Live, fd.Event, CamLook + "," + Fisheye, crf);
        var dw = new Driveway();
        Clip(outDir, "driveway", Driveway.W, Driveway.H, dw.Live, dw.Event, CamLook, crf);
        var by = new Backyard();
        Clip(outDir, "backyard", Backyard.W, Backyard.H, by.Live, by.Event, CamLook, crf);
        var gr = new Garage();
        Clip(outDir, "garage", Garage.W, Garage.H, gr.Live, gr.Event, Infrared, crf + 1);
        var lr = new LivingRoom();
        Clip(outDir, "living-room", LivingRoom.W, LivingRoom.H, lr.Live, lr.Event, CamLook, crf);

        Still(outDir, "front-door-live", "front-door-live", 0.5);
        Still(outDir, "front-door-event", "front-door-event", 4.6);   // courier walking up with a box
        Still(outDir, "front-door-ring", "front-door-event", 8.0);    // at the door, ringing
        Still(outDir, "front-door-package", "front-door-event", 13.2); // box left on the porch
        Still(outDir, "driveway-live", "driveway-live", 0.5);
        Still(outDir, "driveway-street", "driveway-live", 5.0);   // a car passing on the street
        Still(outDir, "driveway-event", "driveway-event", 8.5);
        Still(outDir, "backyard-live", "backyard-live", 0.5);
        Still(outDir, "backyard-event", "backyard-event", 3.4);
        Still(outDir, "garage-live", "garage-live", 0.5);
        Still(outDir, "garage-event", "garage-event", 4.0);
        Still(outDir, "living-room-live", "living-room-live", 0.5);
        Still(outDir, "living-room-event", "living-room-event", 3.6);
    }

    const double EventSeconds = 14.4;

    static void Clip(string dir, string name, int w, int h, Painter live, Painter ev, string vf, int crf)
    {
        Encode(Path.Combine(dir, name + "-live.mp4"), w, h, Loop, live, vf, crf);
        Encode(Path.Combine(dir, name + "-event.mp4"), w, h, EventSeconds, ev, vf, crf);
    }

    /// A JPEG still taken from the encoded clip, so it carries the same camera look.
    static void Still(string dir, string name, string clip, double at)
    {
        string src = Path.Combine(dir, clip + ".mp4");
        string dst = Path.Combine(dir, name + ".jpg");
        string args = string.Format(System.Globalization.CultureInfo.InvariantCulture,
            "-y -hide_banner -loglevel error -ss {0} -i \"{1}\" -frames:v 1 -vf \"{3}scale='min(854,iw)':-2\" -q:v 6 \"{2}\"", at, src, dst,
            // The wide driveway view is shown cropped to 16:9 until someone pans it.
            clip.StartsWith("driveway") ? "crop=ih*16/9:ih," : "");
        var psi = new ProcessStartInfo(Ffmpeg, args);
        psi.UseShellExecute = false;
        var p = Process.Start(psi);
        p.WaitForExit();
        if (p.ExitCode != 0) throw new Exception("ffmpeg still failed for " + name);
    }

    // ---------- encoding ----------

    public static void Encode(string outPath, int w, int h, double seconds, Painter paint, string vf, int crf)
    {
        string args = string.Format(
            "-y -hide_banner -loglevel error -f rawvideo -pix_fmt bgra -s {0}x{1} -r {2} -i - -vf \"{3}\" " +
            "-c:v libx264 -preset slow -crf {4} -pix_fmt yuv420p -profile:v main -g 30 -movflags +faststart -an \"{5}\"",
            w, h, Fps, vf, crf, outPath);
        var psi = new ProcessStartInfo(Ffmpeg, args);
        psi.UseShellExecute = false;
        psi.RedirectStandardInput = true;
        // The redirected stdin writer otherwise starts with a UTF-8 byte-order mark, which
        // would shift every pixel by 3 bytes.
        Console.InputEncoding = new System.Text.UTF8Encoding(false);
        var p = Process.Start(psi);
        var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        var buf = new byte[w * h * 4];
        var s = p.StandardInput.BaseStream;
        int n = (int)Math.Round(seconds * Fps);
        for (int i = 0; i < n; i++)
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingQuality = CompositingQuality.HighQuality;
                paint(g, (double)i / Fps);
            }
            var d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            Marshal.Copy(d.Scan0, buf, 0, buf.Length);
            bmp.UnlockBits(d);
            s.Write(buf, 0, buf.Length);
        }
        s.Close();
        p.WaitForExit();
        if (p.ExitCode != 0) throw new Exception("ffmpeg failed for " + outPath);
    }

    // ---------- small helpers ----------

    static Color Rgb(int r, int g, int b) { return Color.FromArgb(255, r, g, b); }
    static Color A(int a, Color c) { return Color.FromArgb(Math.Max(0, Math.Min(255, a)), c.R, c.G, c.B); }
    static Color Shade(Color c, double f)
    {
        Func<int, int> k = delegate (int v) { return Math.Max(0, Math.Min(255, (int)(v * f))); };
        return Color.FromArgb(c.A, k(c.R), k(c.G), k(c.B));
    }
    static Color Jitter(Random r, Color c, int amt)
    {
        int d = r.Next(-amt, amt + 1);
        return Color.FromArgb(c.A, Clamp(c.R + d), Clamp(c.G + d), Clamp(c.B + d));
    }
    static int Clamp(int v) { return Math.Max(0, Math.Min(255, v)); }
    static double Clamp01(double v) { return Math.Max(0, Math.Min(1, v)); }
    static double Lerp(double a, double b, double t) { return a + (b - a) * t; }
    static double Ease(double t) { t = Clamp01(t); return t * t * (3 - 2 * t); }
    static double EaseOut(double t) { t = Clamp01(t); return 1 - (1 - t) * (1 - t); }
    /// Progress of t through [a, b], 0..1.
    static double Seg(double t, double a, double b) { return Clamp01((t - a) / (b - a)); }
    static double Wave(double t, int k, double phase) { return Math.Sin(2 * Math.PI * k * t / Loop + phase); }

    static void Gradient(Graphics g, RectangleF r, Color top, Color bottom)
    {
        using (var b = new LinearGradientBrush(new RectangleF(r.X, r.Y - 1, r.Width, r.Height + 2), top, bottom, LinearGradientMode.Vertical))
            g.FillRectangle(b, r);
    }
    static void Fill(Graphics g, Color c, params PointF[] pts) { using (var b = new SolidBrush(c)) g.FillPolygon(b, pts); }
    static void Ellipse(Graphics g, Color c, double cx, double cy, double rx, double ry)
    {
        using (var b = new SolidBrush(c)) g.FillEllipse(b, (float)(cx - rx), (float)(cy - ry), (float)(rx * 2), (float)(ry * 2));
    }
    static void Rect(Graphics g, Color c, double x, double y, double w, double h)
    {
        using (var b = new SolidBrush(c)) g.FillRectangle(b, (float)x, (float)y, (float)w, (float)h);
    }
    static void RoundRect(Graphics g, Color c, double x, double y, double w, double h, double rad)
    {
        float r = (float)Math.Max(0.5, Math.Min(rad, Math.Min(w, h) / 2));
        using (var path = new GraphicsPath())
        {
            float fx = (float)x, fy = (float)y, fw = (float)w, fh = (float)h;
            path.AddArc(fx, fy, r * 2, r * 2, 180, 90);
            path.AddArc(fx + fw - r * 2, fy, r * 2, r * 2, 270, 90);
            path.AddArc(fx + fw - r * 2, fy + fh - r * 2, r * 2, r * 2, 0, 90);
            path.AddArc(fx, fy + fh - r * 2, r * 2, r * 2, 90, 90);
            path.CloseFigure();
            using (var b = new SolidBrush(c)) g.FillPath(b, path);
        }
    }
    static void Line(Graphics g, Color c, double w, double x1, double y1, double x2, double y2)
    {
        using (var p = new Pen(c, (float)w))
        {
            p.StartCap = LineCap.Round;
            p.EndCap = LineCap.Round;
            g.DrawLine(p, (float)x1, (float)y1, (float)x2, (float)y2);
        }
    }
    static PointF P(double x, double y) { return new PointF((float)x, (float)y); }

    /// Random speckles for texture (concrete, asphalt, carpet).
    static void Speckle(Graphics g, Random r, RectangleF area, Color c, int n, int amt, double size)
    {
        for (int i = 0; i < n; i++)
        {
            double x = area.X + r.NextDouble() * area.Width, y = area.Y + r.NextDouble() * area.Height;
            Rect(g, A(70, Jitter(r, c, amt)), x, y, size, size);
        }
    }

    /// Grass blades whose size grows toward the bottom (perspective).
    static void Grass(Graphics g, Random r, RectangleF area, Color c, int n, double nearScale)
    {
        Rect(g, c, area.X, area.Y, area.Width, area.Height);
        for (int i = 0; i < n; i++)
        {
            double x = area.X + r.NextDouble() * area.Width, y = area.Y + r.NextDouble() * area.Height;
            double depth = (y - area.Y) / area.Height;
            double len = (1.5 + depth * 6 * nearScale) * (0.6 + r.NextDouble() * 0.8);
            Color k = Jitter(r, r.Next(3) == 0 ? Shade(c, 1.25) : Shade(c, 0.8), 12);
            Line(g, A(150, k), 0.6 + depth * nearScale, x, y, x + (r.NextDouble() - 0.5) * len * 0.5, y - len);
        }
    }

    static void Shadow(Graphics g, double cx, double cy, double rx, double ry, int alpha)
    {
        Ellipse(g, A(alpha, Color.Black), cx, cy, rx, ry);
    }

    // ---------- actors ----------

    public class Look
    {
        public Color Skin, Hair, Shirt, Pants, Shoes, Cap;
        public bool HasCap;
        public Look(Color skin, Color hair, Color shirt, Color pants, Color shoes)
        {
            Skin = skin; Hair = hair; Shirt = shirt; Pants = pants; Shoes = shoes;
        }
    }

    /// facing: -1 walking left, 1 walking right, 0 toward camera, 2 away from camera.
    static void Person(Graphics g, double x, double feet, double h, double phase, int facing, Look L, bool box, double shade)
    {
        Color skin = Shade(L.Skin, shade), hair = Shade(L.Hair, shade), shirt = Shade(L.Shirt, shade),
            pants = Shade(L.Pants, shade), shoes = Shade(L.Shoes, shade), cap = Shade(L.Cap, shade);
        double bob = Math.Abs(Math.Sin(phase)) * h * 0.012;
        double top = feet - h - bob;
        double headR = h * 0.068;
        double headY = top + headR;
        double shY = top + h * 0.17;
        double hipY = feet - h * 0.47 - bob;
        double legW = h * 0.085, armW = h * 0.06;
        Shadow(g, x, feet, h * 0.17, h * 0.035, 70);

        if (facing == -1 || facing == 1)
        {
            int f = facing;
            double tw = h * 0.16;
            double swing = Math.Sin(phase) * 0.5;
            double legL = feet - hipY;
            // back leg, back arm (darker), torso, front leg, front arm
            Action<double, Color> leg = delegate (double a, Color c)
            {
                double kx = x + Math.Sin(a) * legL * 0.5 * f, ky = hipY + Math.Cos(a) * legL * 0.5;
                double fx = x + Math.Sin(a) * legL * f + (a < 0 ? -Math.Sin(a) * legL * 0.15 * f : 0), fy = feet - bob * 0.2;
                Line(g, c, legW, x, hipY, kx, ky);
                Line(g, c, legW * 0.95, kx, ky, fx, fy - legW * 0.3);
                Line(g, shoes, legW * 0.8, fx - f * legW * 0.1, fy - legW * 0.25, fx + f * legW * 0.55, fy - legW * 0.25);
            };
            Action<double, Color> arm = delegate (double a, Color c)
            {
                double ax = x + Math.Sin(a) * h * 0.36 * f, ay = shY + h * 0.03 + Math.Cos(a) * h * 0.36;
                Line(g, c, armW, x, shY + h * 0.03, ax, ay);
                Ellipse(g, skin, ax, ay, armW * 0.55, armW * 0.55);
            };
            leg(-swing, Shade(pants, 0.75));
            if (!box) arm(swing * 0.8, Shade(shirt, 0.75));
            RoundRect(g, shirt, x - tw / 2, shY, tw, hipY - shY + h * 0.05, tw * 0.35);
            leg(swing, pants);
            Ellipse(g, skin, x + f * headR * 0.15, headY, headR * 0.92, headR);
            using (var b = new SolidBrush(hair))
                g.FillPie(b, (float)(x + f * headR * 0.15 - headR), (float)(headY - headR), (float)(headR * 2), (float)(headR * 2), f > 0 ? 160 : 200, 180);
            Ellipse(g, hair, x - f * headR * 0.5, headY - headR * 0.1, headR * 0.5, headR * 0.6);
            if (L.HasCap)
            {
                using (var b = new SolidBrush(cap))
                    g.FillPie(b, (float)(x - headR), (float)(headY - headR * 1.1), (float)(headR * 2), (float)(headR * 1.8), 180, 180);
                Line(g, cap, headR * 0.3, x, headY - headR * 0.15, x + f * headR * 1.6, headY - headR * 0.1);
            }
            if (box)
            {
                Line(g, shirt, armW, x, shY + h * 0.04, x + f * h * 0.17, shY + h * 0.2);
                BoxShape(g, x + f * h * 0.17, shY + h * 0.27, h * 0.22, h * 0.17, shade);
            }
            else arm(-swing * 0.8, shirt);
        }
        else
        {
            bool front = facing == 0;
            double tw = h * 0.26;
            double s = Math.Sin(phase);
            double liftL = Math.Max(0, s) * h * 0.035, liftR = Math.Max(0, -s) * h * 0.035;
            double lx = x - h * 0.055, rx = x + h * 0.055;
            Line(g, pants, legW, lx, hipY, lx, feet - liftL - legW * 0.3);
            Line(g, pants, legW, rx, hipY, rx, feet - liftR - legW * 0.3);
            RoundRect(g, shoes, lx - legW * 0.6, feet - liftL - legW * 0.55, legW * 1.2, legW * 0.6, legW * 0.25);
            RoundRect(g, shoes, rx - legW * 0.6, feet - liftR - legW * 0.55, legW * 1.2, legW * 0.6, legW * 0.25);
            RoundRect(g, pants, x - tw * 0.45, hipY - h * 0.04, tw * 0.9, h * 0.1, h * 0.03);
            RoundRect(g, shirt, x - tw / 2, shY, tw, hipY - shY + h * 0.04, tw * 0.3);
            if (!box)
            {
                double sw = s * h * 0.025;
                Line(g, Shade(shirt, 0.9), armW, x - tw / 2 - armW * 0.1, shY + h * 0.04, x - tw / 2 - armW * 0.3, shY + h * 0.33 + sw);
                Line(g, Shade(shirt, 0.9), armW, x + tw / 2 + armW * 0.1, shY + h * 0.04, x + tw / 2 + armW * 0.3, shY + h * 0.33 - sw);
                Ellipse(g, skin, x - tw / 2 - armW * 0.3, shY + h * 0.35 + sw, armW * 0.5, armW * 0.55);
                Ellipse(g, skin, x + tw / 2 + armW * 0.3, shY + h * 0.35 - sw, armW * 0.5, armW * 0.55);
            }
            Rect(g, skin, x - headR * 0.35, headY + headR * 0.7, headR * 0.7, headR * 0.6);
            Ellipse(g, front ? skin : hair, x, headY, headR * 0.9, headR);
            if (front)
            {
                using (var b = new SolidBrush(hair))
                    g.FillPie(b, (float)(x - headR * 0.95), (float)(headY - headR * 1.05), (float)(headR * 1.9), (float)(headR * 1.5), 180, 180);
                Ellipse(g, A(160, Shade(skin, 0.55)), x - headR * 0.32, headY + headR * 0.05, headR * 0.09, headR * 0.07);
                Ellipse(g, A(160, Shade(skin, 0.55)), x + headR * 0.32, headY + headR * 0.05, headR * 0.09, headR * 0.07);
            }
            if (L.HasCap)
            {
                using (var b = new SolidBrush(cap))
                    g.FillPie(b, (float)(x - headR), (float)(headY - headR * 1.12), (float)(headR * 2), (float)(headR * 1.7), 180, 180);
                if (front) Ellipse(g, Shade(cap, 0.8), x, headY - headR * 0.2, headR * 1.05, headR * 0.22);
            }
            if (box)
            {
                Line(g, shirt, armW, x - tw / 2, shY + h * 0.05, x - tw * 0.3, shY + h * 0.24);
                Line(g, shirt, armW, x + tw / 2, shY + h * 0.05, x + tw * 0.3, shY + h * 0.24);
                BoxShape(g, x, shY + h * 0.27, h * 0.28, h * 0.19, shade);
            }
        }
    }

    static void BoxShape(Graphics g, double cx, double cy, double w, double h, double shade)
    {
        Color kraft = Shade(Rgb(176, 132, 84), shade);
        Fill(g, Shade(kraft, 1.15), P(cx - w / 2, cy - h / 2), P(cx - w / 2 + w * 0.12, cy - h / 2 - h * 0.18), P(cx + w / 2 + w * 0.12, cy - h / 2 - h * 0.18), P(cx + w / 2, cy - h / 2));
        Fill(g, Shade(kraft, 0.8), P(cx + w / 2, cy - h / 2), P(cx + w / 2 + w * 0.12, cy - h / 2 - h * 0.18), P(cx + w / 2 + w * 0.12, cy + h / 2 - h * 0.18), P(cx + w / 2, cy + h / 2));
        Rect(g, kraft, cx - w / 2, cy - h / 2, w, h);
        Rect(g, A(200, Shade(Rgb(210, 200, 170), shade)), cx - w * 0.06, cy - h / 2, w * 0.12, h);
        Rect(g, A(230, Color.White), cx + w * 0.12, cy - h * 0.15, w * 0.25, h * 0.2);
    }

    /// Side-view car; dir -1 drives left, 1 right. x = center, y = ground.
    static void CarSide(Graphics g, double x, double y, double w, Color body, int dir, double wheelTurn)
    {
        double h = w * 0.36;
        Shadow(g, x, y, w * 0.52, h * 0.12, 90);
        RoundRect(g, body, x - w / 2, y - h * 0.72, w, h * 0.5, h * 0.18);
        double cabX = x - w * 0.27 + dir * w * 0.02;
        Fill(g, Shade(body, 0.95), P(cabX - w * 0.1, y - h * 0.7), P(cabX + w * 0.04, y - h * 1.12), P(cabX + w * 0.42, y - h * 1.12), P(cabX + w * 0.56, y - h * 0.7));
        Fill(g, Rgb(60, 72, 84), P(cabX - w * 0.04, y - h * 0.74), P(cabX + w * 0.07, y - h * 1.05), P(cabX + w * 0.23, y - h * 1.05), P(cabX + w * 0.23, y - h * 0.74));
        Fill(g, Rgb(70, 84, 96), P(cabX + w * 0.26, y - h * 0.74), P(cabX + w * 0.26, y - h * 1.05), P(cabX + w * 0.39, y - h * 1.05), P(cabX + w * 0.5, y - h * 0.74));
        Rect(g, Shade(body, 0.7), x - w / 2, y - h * 0.45, w, h * 0.05);
        Ellipse(g, dir < 0 ? Rgb(250, 245, 220) : Rgb(190, 30, 30), x - w / 2 + w * 0.02, y - h * 0.55, w * 0.02, h * 0.06);
        Ellipse(g, dir < 0 ? Rgb(190, 30, 30) : Rgb(250, 245, 220), x + w / 2 - w * 0.02, y - h * 0.55, w * 0.02, h * 0.06);
        foreach (double wx in new[] { x - w * 0.3, x + w * 0.3 })
        {
            Ellipse(g, Rgb(25, 25, 28), wx, y - h * 0.22, h * 0.24, h * 0.24);
            Ellipse(g, Rgb(150, 150, 155), wx, y - h * 0.22, h * 0.12, h * 0.12);
            double a = wheelTurn;
            Line(g, Rgb(90, 90, 95), h * 0.03, wx - Math.Cos(a) * h * 0.11, y - h * 0.22 - Math.Sin(a) * h * 0.11, wx + Math.Cos(a) * h * 0.11, y - h * 0.22 + Math.Sin(a) * h * 0.11);
        }
    }

    /// Front-view car (driving toward the camera). x = center, y = ground.
    static void CarFront(Graphics g, double x, double y, double w, Color body, bool lights)
    {
        double h = w * 0.62;
        Shadow(g, x, y, w * 0.58, w * 0.07, 110);
        Rect(g, Rgb(22, 22, 24), x - w * 0.47, y - h * 0.22, w * 0.16, h * 0.22);
        Rect(g, Rgb(22, 22, 24), x + w * 0.31, y - h * 0.22, w * 0.16, h * 0.22);
        Fill(g, Shade(body, 0.9), P(x - w * 0.36, y - h * 0.62), P(x - w * 0.3, y - h * 0.98), P(x + w * 0.3, y - h * 0.98), P(x + w * 0.36, y - h * 0.62));
        Fill(g, Rgb(58, 70, 82), P(x - w * 0.31, y - h * 0.64), P(x - w * 0.26, y - h * 0.92), P(x + w * 0.26, y - h * 0.92), P(x + w * 0.31, y - h * 0.64));
        Fill(g, A(60, Color.White), P(x - w * 0.2, y - h * 0.66), P(x - w * 0.05, y - h * 0.9), P(x + w * 0.02, y - h * 0.9), P(x - w * 0.12, y - h * 0.66));
        RoundRect(g, body, x - w / 2, y - h * 0.64, w, h * 0.5, h * 0.12);
        Rect(g, Shade(body, 1.12), x - w * 0.48, y - h * 0.62, w * 0.96, h * 0.06);
        RoundRect(g, Rgb(35, 36, 40), x - w * 0.2, y - h * 0.44, w * 0.4, h * 0.14, h * 0.04);
        Color hl = lights ? Rgb(255, 252, 230) : Rgb(200, 205, 210);
        RoundRect(g, hl, x - w * 0.45, y - h * 0.5, w * 0.18, h * 0.08, h * 0.03);
        RoundRect(g, hl, x + w * 0.27, y - h * 0.5, w * 0.18, h * 0.08, h * 0.03);
        if (lights)
        {
            Ellipse(g, A(60, Color.White), x - w * 0.36, y - h * 0.46, w * 0.16, h * 0.12);
            Ellipse(g, A(60, Color.White), x + w * 0.36, y - h * 0.46, w * 0.16, h * 0.12);
        }
        Rect(g, Rgb(235, 235, 230), x - w * 0.09, y - h * 0.27, w * 0.18, h * 0.07);
        Rect(g, Shade(body, 0.6), x - w / 2, y - h * 0.2, w, h * 0.06);
    }

    static void Dog(Graphics g, double x, double y, double s, double phase, int dir, bool running)
    {
        Color fur = Rgb(201, 152, 84), dark = Rgb(150, 105, 52);
        double bodyY = y - s * 0.42 - (running ? Math.Abs(Math.Sin(phase)) * s * 0.06 : 0);
        Shadow(g, x, y, s * 0.42, s * 0.06, 70);
        double a = running ? Math.Sin(phase) * 0.7 : Math.Sin(phase) * 0.05;
        Action<double, double, Color> leg = delegate (double ox, double ang, Color c)
        {
            Line(g, c, s * 0.085, x + ox * dir, bodyY + s * 0.05, x + ox * dir + Math.Sin(ang) * s * 0.3 * dir, y - s * 0.03);
        };
        leg(-s * 0.26, a, dark);
        leg(s * 0.24, -a, dark);
        // tail
        double tw = Math.Sin(phase * 2) * s * 0.06;
        Line(g, fur, s * 0.06, x - s * 0.36 * dir, bodyY - s * 0.04, x - s * 0.55 * dir, bodyY - s * 0.2 + tw);
        Ellipse(g, fur, x, bodyY, s * 0.38, s * 0.16);
        leg(-s * 0.2, -a, fur);
        leg(s * 0.3, a, fur);
        double hx = x + s * 0.4 * dir, hy = bodyY - s * 0.17;
        Line(g, fur, s * 0.16, x + s * 0.25 * dir, bodyY - s * 0.05, hx, hy);
        Ellipse(g, fur, hx, hy, s * 0.12, s * 0.11);
        Ellipse(g, fur, hx + s * 0.11 * dir, hy + s * 0.03, s * 0.09, s * 0.06);
        Ellipse(g, Rgb(30, 25, 20), hx + s * 0.19 * dir, hy + s * 0.02, s * 0.025, s * 0.025);
        Ellipse(g, dark, hx - s * 0.04 * dir, hy - s * 0.02, s * 0.05, s * 0.09);
        Ellipse(g, Rgb(20, 20, 20), hx + s * 0.04 * dir, hy - s * 0.03, s * 0.015, s * 0.015);
        Rect(g, Rgb(200, 40, 40), hx - s * 0.1 * dir - s * 0.02, hy + s * 0.06, s * 0.05, s * 0.07);
    }

    /// A leafy tree. sway = horizontal canopy offset in pixels.
    static void Tree(Graphics g, Random rnd, double x, double ground, double h, Color leaf, double t, int seed)
    {
        var r = new Random(seed);
        Fill(g, Rgb(92, 70, 52), P(x - h * 0.035, ground), P(x - h * 0.02, ground - h * 0.55), P(x + h * 0.02, ground - h * 0.55), P(x + h * 0.035, ground));
        for (int i = 0; i < 26; i++)
        {
            double ang = r.NextDouble() * Math.PI * 2, rad = Math.Sqrt(r.NextDouble());
            double cx = x + Math.Cos(ang) * rad * h * 0.33, cy = ground - h * 0.66 + Math.Sin(ang) * rad * h * 0.28;
            double hgt = (ground - cy) / h;
            double sway = Wave(t, 1, r.NextDouble() * 0.6 + i * 0.05) * h * 0.012 * hgt + Wave(t, 3, i) * h * 0.004;
            double br = 0.75 + (1 - Math.Sin(ang)) * 0.12 + r.NextDouble() * 0.15;
            Ellipse(g, Shade(leaf, br), cx + sway, cy, h * (0.1 + r.NextDouble() * 0.08), h * (0.09 + r.NextDouble() * 0.06));
        }
    }

    static void Bush(Graphics g, double x, double y, double s, Color c, int seed, double t)
    {
        var r = new Random(seed);
        for (int i = 0; i < 9; i++)
        {
            double cx = x + (r.NextDouble() - 0.5) * s * 1.2, cy = y - r.NextDouble() * s * 0.5;
            Ellipse(g, Shade(c, 0.75 + r.NextDouble() * 0.4), cx + Wave(t, 2, i) * s * 0.015, cy, s * 0.35, s * 0.28);
        }
    }

    static void Cloud(Graphics g, double x, double y, double s, int alpha)
    {
        Ellipse(g, A(alpha, Color.White), x, y, s, s * 0.35);
        Ellipse(g, A(alpha, Color.White), x - s * 0.45, y + s * 0.08, s * 0.5, s * 0.25);
        Ellipse(g, A(alpha, Color.White), x + s * 0.2, y - s * 0.18, s * 0.45, s * 0.3);
        Ellipse(g, A(alpha, Color.White), x + s * 0.6, y + s * 0.05, s * 0.45, s * 0.22);
    }

    static void House(Graphics g, Random r, double x, double baseY, double w, double h, Color wall, Color roof)
    {
        Rect(g, wall, x, baseY - h, w, h);
        Fill(g, roof, P(x - w * 0.06, baseY - h), P(x + w / 2, baseY - h - h * 0.55), P(x + w * 1.06, baseY - h));
        int cols = Math.Max(2, (int)(w / 26));
        for (int i = 0; i < cols; i++)
        {
            double wx = x + w * (i + 0.5) / cols - w * 0.06;
            Rect(g, Rgb(70, 80, 92), wx, baseY - h * 0.75, w * 0.12, h * 0.28);
            Rect(g, A(120, Color.White), wx, baseY - h * 0.75, w * 0.12, h * 0.04);
        }
        Rect(g, Shade(wall, 0.6), x + w * 0.44, baseY - h * 0.42, w * 0.12, h * 0.42);
    }

    // ---------- scenes ----------

    static Look Courier()
    {
        var l = new Look(Rgb(198, 150, 118), Rgb(40, 30, 25), Rgb(44, 62, 98), Rgb(52, 56, 66), Rgb(30, 30, 30));
        l.HasCap = true; l.Cap = Rgb(44, 62, 98);
        return l;
    }

    // Front door (doorbell camera, 4:3). Event: a courier walks up, leaves a box, rings, leaves.
    public class FrontDoor
    {
        public const int W = 640, H = 480;
        Bitmap bg;
        Look courier = Courier();
        public FrontDoor()
        {
            bg = new Bitmap(W, H);
            var r = new Random(11);
            using (var g = Graphics.FromImage(bg))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                Gradient(g, new RectangleF(0, 0, W, 175), Rgb(150, 190, 228), Rgb(214, 228, 238));
                House(g, r, 20, 178, 150, 62, Rgb(200, 188, 168), Rgb(96, 82, 76));
                House(g, r, 250, 178, 170, 70, Rgb(176, 190, 196), Rgb(70, 74, 86));
                House(g, r, 490, 178, 160, 60, Rgb(214, 204, 180), Rgb(120, 92, 74));
                Rect(g, Rgb(86, 88, 92), 0, 176, W, 34);
                Speckle(g, r, new RectangleF(0, 176, W, 34), Rgb(110, 110, 112), 900, 20, 1.2);
                for (int i = 0; i < 8; i++) Rect(g, Rgb(220, 210, 150), i * 90 + 20, 192, 40, 2);
                Rect(g, Rgb(196, 194, 188), 0, 210, W, 16);
                Rect(g, Rgb(170, 168, 162), 0, 224, W, 3);
                Grass(g, r, new RectangleF(0, 227, W, 183), Rgb(86, 134, 62), 9000, 1.6);
                Fill(g, Rgb(190, 184, 172), P(290, 227), P(350, 227), P(470, 410), P(170, 410));
                for (int i = 0; i < 9; i++)
                {
                    double y = 227 + Math.Pow(i / 9.0, 1.4) * 183;
                    double half = 30 + (y - 227) / 183 * 120;
                    Line(g, Rgb(160, 154, 142), 1 + i * 0.2, 320 - half, y, 320 + half, y);
                }
                Speckle(g, r, new RectangleF(170, 227, 300, 183), Rgb(160, 150, 140), 1600, 25, 1.4);
                for (int i = 0; i < 7; i++)
                {
                    double y = 250 + i * 24; double half = 30 + (y - 227) / 183 * 120;
                    Bush(g, 320 - half - 26 - i * 3, y, 22 + i * 5, Rgb(70, 120, 60), 100 + i, 0);
                    Ellipse(g, Rgb(220, 90, 120), 320 - half - 14, y - 10, 3 + i * 0.6, 3 + i * 0.6);
                    Bush(g, 320 + half + 26 + i * 3, y, 22 + i * 5, Rgb(70, 120, 60), 200 + i, 0);
                    Ellipse(g, Rgb(240, 200, 80), 320 + half + 16, y - 12, 3 + i * 0.6, 3 + i * 0.6);
                }
                // porch
                Gradient(g, new RectangleF(0, 410, W, 70), Rgb(150, 132, 112), Rgb(120, 104, 88));
                for (int i = 0; i < 6; i++) Line(g, Rgb(108, 94, 80), 1.5, 0, 418 + i * 11, W, 418 + i * 11);
                Rect(g, Rgb(200, 196, 188), 0, 404, W, 8);
                RoundRect(g, Rgb(70, 52, 44), 200, 440, 240, 60, 6);
                Speckle(g, r, new RectangleF(204, 444, 232, 40), Rgb(100, 80, 60), 500, 20, 2);
                // porch column and planter
                Gradient(g, new RectangleF(0, 0, 54, H), Rgb(236, 234, 228), Rgb(196, 192, 184));
                Rect(g, Rgb(170, 166, 160), 50, 0, 6, H);
                Fill(g, Rgb(150, 86, 60), P(540, 360), P(610, 360), P(600, 420), P(550, 420));
                Bush(g, 575, 360, 60, Rgb(60, 118, 66), 300, 0);
            }
        }
        void Ambient(Graphics g, double t)
        {
            g.DrawImageUnscaled(bg, 0, 0);
            Cloud(g, 140 + Wave(t, 1, 0) * 8, 50, 60, 170);
            Cloud(g, 470 + Wave(t, 1, 2) * 8, 85, 45, 150);
            var r = new Random(1);
            Tree(g, r, 205, 182, 120, Rgb(70, 112, 58), t, 5);
            Tree(g, r, 470, 182, 105, Rgb(84, 122, 62), t, 6);
        }
        public void Live(Graphics g, double t)
        {
            Ambient(g, t);
            // a car passes on the street now and then
            double p = Seg(t, 3, 7.5);
            if (p > 0 && p < 1) CarSide(g, Lerp(W + 80, -80, p), 205, 120, Rgb(120, 30, 34), -1, t * 12);
            Overlay(g, t);
        }
        // courier path: sidewalk (y 218) → up the walk to the porch (y 452) and back
        public void Event(Graphics g, double t)
        {
            Ambient(g, t);
            bool boxDown = t > 7.2;
            if (boxDown) BoxShape(g, 430, 436, 84, 62, 1.0);
            double feet, x, h; int facing; bool carry = !boxDown;
            Func<double, double> hAt = delegate (double y) { return 46 + (y - 218) / (452 - 218) * 300; };
            if (t < 2.6) { double q = Seg(t, 0.4, 2.6); x = Lerp(-30, 320, q); feet = 218; facing = 1; }
            else if (t < 6.4) { double q = Ease(Seg(t, 2.6, 6.4)); feet = Lerp(218, 452, q); x = 320 + Math.Sin(q * 3) * 6; facing = 0; }
            else if (t < 8.8) { feet = 452; x = 330; facing = 0; }
            else if (t < 12.4) { double q = Ease(Seg(t, 8.8, 12.4)); feet = Lerp(452, 218, q); x = 320; facing = 2; carry = false; }
            else { double q = Seg(t, 12.4, 14.4); x = Lerp(320, -40, q); feet = 218; facing = -1; carry = false; }
            if (t >= 6.4 && t < 7.2) carry = true;
            h = hAt(feet);
            double phase = (facing == 0 && t >= 6.4 && t < 8.8) ? 0 : t * 7.5;
            if (t >= 0.4) Person(g, x, feet, h, phase, facing, courier, carry, 1.0);

            Overlay(g, t);
        }
        void Overlay(Graphics g, double t) { }
    }

    // Driveway: a wide 8:3 view the app pans across (PTZ). Event: a car pulls in.
    public class Driveway
    {
        public const int W = 1280, H = 480;
        Bitmap bg;
        public Driveway()
        {
            bg = new Bitmap(W, H);
            var r = new Random(21);
            using (var g = Graphics.FromImage(bg))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                Gradient(g, new RectangleF(0, 0, W, 160), Rgb(140, 182, 224), Rgb(208, 224, 236));
                double[] hx = { 30, 250, 470, 760, 1000 };
                for (int i = 0; i < hx.Length; i++)
                    House(g, r, hx[i], 168, 170 + (i % 2) * 30, 60 + (i % 3) * 8, i % 2 == 0 ? Rgb(206, 196, 178) : Rgb(180, 192, 200), i % 2 == 0 ? Rgb(100, 84, 76) : Rgb(72, 76, 88));
                Rect(g, Rgb(84, 86, 90), 0, 166, W, 46);
                Speckle(g, r, new RectangleF(0, 166, W, 46), Rgb(110, 110, 112), 2500, 20, 1.3);
                for (int i = 0; i < 14; i++) Rect(g, Rgb(222, 212, 150), i * 100 + 10, 188, 46, 2.5);
                Rect(g, Rgb(198, 196, 190), 0, 212, W, 14);
                Rect(g, Rgb(168, 166, 160), 0, 224, W, 3);
                Grass(g, r, new RectangleF(0, 227, W, 253), Rgb(84, 132, 60), 26000, 2.0);
                Fill(g, Rgb(176, 174, 168), P(575, 212), P(705, 212), P(1010, 480), P(270, 480));
                Speckle(g, r, new RectangleF(270, 212, 740, 268), Rgb(150, 148, 140), 5000, 22, 1.5);
                for (int i = 1; i < 5; i++)
                {
                    double y = 212 + Math.Pow(i / 5.0, 1.5) * 268;
                    double half = 65 + (y - 212) / 268 * 305;
                    Line(g, Rgb(150, 148, 142), 1.2, 640 - half, y, 640 + half, y);
                }
                Line(g, Rgb(150, 148, 142), 1.2, 640, 212, 640, 480);
                for (int i = 0; i < 10; i++) Bush(g, 60 + i * 50, 300 + (i % 3) * 6, 50, Rgb(64, 112, 58), 400 + i, 0);
                for (int i = 0; i < 9; i++) Ellipse(g, i % 2 == 0 ? Rgb(230, 120, 150) : Rgb(250, 220, 90), 70 + i * 52, 290 + (i % 3) * 5, 5, 5);
                // mailbox
                Rect(g, Rgb(80, 70, 60), 538, 196, 5, 40);
                RoundRect(g, Rgb(40, 44, 50), 526, 184, 30, 16, 6);
                // garage door edge (camera is mounted above it)
                Gradient(g, new RectangleF(1180, 300, 100, 180), Rgb(226, 224, 218), Rgb(190, 188, 182));
                for (int i = 0; i < 5; i++) Line(g, Rgb(170, 168, 162), 2, 1180, 320 + i * 34, W, 320 + i * 34);
            }
        }
        void Ambient(Graphics g, double t)
        {
            g.DrawImageUnscaled(bg, 0, 0);
            Cloud(g, 200 + Wave(t, 1, 0) * 10, 50, 70, 170);
            Cloud(g, 720 + Wave(t, 1, 1) * 10, 80, 55, 150);
            Cloud(g, 1100 + Wave(t, 1, 2) * 10, 40, 60, 160);
            var r = new Random(1);
            Tree(g, r, 400, 176, 130, Rgb(74, 114, 58), t, 9);
            Tree(g, r, 880, 176, 120, Rgb(82, 120, 62), t, 10);
            Tree(g, r, 1080, 380, 360, Rgb(66, 108, 54), t, 11);
        }
        public void Live(Graphics g, double t)
        {
            Ambient(g, t);
            double p = Seg(t, 2, 8);
            if (p > 0 && p < 1) CarSide(g, Lerp(-100, W + 100, p), 202, 130, Rgb(230, 230, 228), 1, t * 12);
        }
        public void Event(Graphics g, double t)
        {
            Ambient(g, t);
            Color c = Rgb(52, 86, 140);
            if (t < 4.2)
            {
                double q = EaseOut(Seg(t, 0.3, 4.2));
                if (t > 0.3) CarSide(g, Lerp(W + 120, 660, q), 204, 150, c, -1, t * 10);
            }
            else
            {
                double q = EaseOut(Seg(t, 4.2, 10.5));
                double y = Lerp(222, 440, q), w = Lerp(100, 360, q);
                CarFront(g, 640 + Math.Sin(q * 2.2) * 12, y, w, c, t < 11.5);
            }
        }
    }

    // Backyard. Event: the dog runs across the lawn, sniffs, and runs back.
    public class Backyard
    {
        public const int W = 854, H = 480;
        Bitmap bg;
        public Backyard()
        {
            bg = new Bitmap(W, H);
            var r = new Random(31);
            using (var g = Graphics.FromImage(bg))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                Gradient(g, new RectangleF(0, 0, W, 200), Rgb(146, 186, 226), Rgb(214, 228, 236));
                Grass(g, r, new RectangleF(0, 240, W, 240), Rgb(88, 138, 64), 22000, 2.2);
                // fence
                for (int i = 0; i < 70; i++)
                {
                    double x = i * 12.4;
                    Color k = Jitter(r, Rgb(150, 112, 78), 14);
                    Rect(g, k, x, 150 + (i % 2) * 2, 11.6, 100);
                    Line(g, Shade(k, 0.7), 0.8, x + 11.6, 152, x + 11.6, 250);
                }
                Rect(g, Rgb(120, 90, 64), 0, 176, W, 5);
                Rect(g, Rgb(120, 90, 64), 0, 226, W, 5);
                // garden bed
                Rect(g, Rgb(96, 70, 52), 0, 244, 520, 16);
                for (int i = 0; i < 12; i++) Bush(g, 20 + i * 42, 252, 34, Rgb(68, 118, 62), 500 + i, 0);
                for (int i = 0; i < 14; i++) Ellipse(g, i % 3 == 0 ? Rgb(230, 80, 90) : i % 3 == 1 ? Rgb(250, 210, 80) : Rgb(170, 120, 220), 18 + i * 37, 238 + (i % 2) * 6, 4, 4);
                // shed
                Rect(g, Rgb(182, 168, 150), 630, 150, 170, 140);
                for (int i = 0; i < 14; i++) Line(g, Rgb(160, 146, 128), 1, 630 + i * 12.2, 150, 630 + i * 12.2, 290);
                Fill(g, Rgb(90, 72, 62), P(615, 152), P(715, 100), P(815, 152));
                Rect(g, Rgb(120, 104, 90), 690, 200, 50, 90);
                Rect(g, Rgb(200, 190, 170), 646, 180, 30, 26);
                // patio
                Fill(g, Rgb(170, 160, 150), P(0, 400), P(260, 400), P(330, 480), P(0, 480));
                for (int i = 0; i < 6; i++) Line(g, Rgb(140, 132, 124), 2, i * 60, 400, i * 70 - 10, 480);
                Line(g, Rgb(140, 132, 124), 2, 0, 440, 300, 440);
                // chairs
                RoundRect(g, Rgb(230, 230, 226), 60, 360, 70, 60, 8);
                RoundRect(g, Rgb(210, 210, 206), 66, 330, 58, 40, 8);
                Ellipse(g, Rgb(220, 70, 60), 520, 400, 10, 10);
            }
        }
        void Ambient(Graphics g, double t)
        {
            g.DrawImageUnscaled(bg, 0, 0);
            Cloud(g, 300 + Wave(t, 1, 0) * 8, 40, 60, 160);
            Cloud(g, 680 + Wave(t, 1, 1) * 8, 60, 50, 150);
            var r = new Random(1);
            Tree(g, r, 140, 160, 200, Rgb(66, 110, 54), t, 12);
            Tree(g, r, 420, 160, 170, Rgb(80, 122, 60), t, 13);
            Tree(g, r, 900, 300, 380, Rgb(62, 104, 52), t, 14);
        }
        public void Live(Graphics g, double t) { Ambient(g, t); }
        public void Event(Graphics g, double t)
        {
            Ambient(g, t);
            if (t < 5) { double q = Seg(t, 0.6, 5); if (t > 0.6) Dog(g, Lerp(-80, 560, q), 380, 120, t * 11, 1, true); }
            else if (t < 7.4) Dog(g, 560, 380, 120, t * 3, 1, false);
            else { double q = Seg(t, 7.4, 11); Dog(g, Lerp(560, -120, q), Lerp(380, 430, q), Lerp(120, 140, q), t * 11, -1, true); }
        }
    }

    // Garage at night (infrared, black and white). Event: someone comes in through the side door.
    public class Garage
    {
        public const int W = 854, H = 480;
        Bitmap bg;
        Look look = new Look(Rgb(190, 150, 120), Rgb(60, 50, 40), Rgb(110, 120, 130), Rgb(60, 66, 80), Rgb(40, 40, 40));
        public Garage()
        {
            bg = new Bitmap(W, H);
            var r = new Random(41);
            using (var g = Graphics.FromImage(bg))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                Rect(g, Rgb(170, 170, 166), 0, 0, W, 320);
                for (int row = 0; row < 16; row++)
                    for (int c = 0; c < 22; c++)
                    {
                        double x = c * 40 + (row % 2) * 20 - 20, y = row * 20;
                        Rect(g, Jitter(r, Rgb(176, 176, 172), 8), x + 1, y + 1, 38, 18);
                    }
                Gradient(g, new RectangleF(0, 320, W, 160), Rgb(150, 150, 146), Rgb(120, 120, 118));
                Speckle(g, r, new RectangleF(0, 320, W, 160), Rgb(130, 130, 126), 4000, 18, 1.6);
                Ellipse(g, A(60, Color.Black), 560, 420, 90, 20);
                // side door frame
                Rect(g, Rgb(120, 118, 114), 70, 90, 120, 236);
                // shelves with boxes
                for (int s = 0; s < 4; s++)
                {
                    double y = 120 + s * 60;
                    Rect(g, Rgb(110, 100, 90), 250, y, 220, 6);
                    for (int b = 0; b < 4; b++)
                        if (r.Next(5) > 0) RoundRect(g, Jitter(r, Rgb(160, 140, 110), 20), 256 + b * 54, y - 40 + r.Next(10), 44 + r.Next(6), 40 - r.Next(10), 2);
                }
                Rect(g, Rgb(100, 92, 84), 250, 116, 6, 210);
                Rect(g, Rgb(100, 92, 84), 464, 116, 6, 210);

            }
        }
        void Door(Graphics g, double open)
        {
            Rect(g, Rgb(26, 26, 28), 76, 96, 108, 230);
            double w = 108 * (1 - open * 0.8);
            Rect(g, Rgb(190, 188, 184), 76, 96, w, 230);
            if (w > 40) Rect(g, Rgb(40, 44, 50), 76 + w * 0.2, 112, w * 0.6, 70);
            Ellipse(g, Rgb(90, 90, 90), 76 + w - 12, 216, 4, 4);
        }
        void Car(Graphics g)
        {
            // rear of the family car, parked on the right
            Shadow(g, 690, 462, 210, 22, 120);
            RoundRect(g, Rgb(90, 92, 98), 500, 260, 380, 190, 34);
            Fill(g, Rgb(80, 82, 88), P(540, 262), P(580, 170), P(800, 170), P(850, 262));
            Fill(g, Rgb(40, 42, 46), P(560, 256), P(592, 184), P(788, 184), P(830, 256));
            RoundRect(g, Rgb(170, 170, 170), 520, 300, 70, 26, 8);
            RoundRect(g, Rgb(170, 170, 170), 790, 300, 70, 26, 8);
            Rect(g, Rgb(220, 220, 220), 655, 340, 70, 30);
            Rect(g, Rgb(60, 60, 64), 500, 400, 380, 18);
        }
        void Bike(Graphics g)
        {
            // a bicycle leaning in the foreground
            foreach (double wx in new double[] { 150, 250 })
                using (var pen = new Pen(Rgb(40, 40, 40), 6)) g.DrawEllipse(pen, (float)(wx - 40), 400, 80, 80);
            Line(g, Rgb(70, 70, 74), 6, 150, 440, 200, 400);
            Line(g, Rgb(70, 70, 74), 6, 200, 400, 250, 440);
            Line(g, Rgb(70, 70, 74), 6, 186, 400, 226, 400);
            Line(g, Rgb(70, 70, 74), 5, 226, 400, 236, 384);
        }
        public void Live(Graphics g, double t)
        {
            g.DrawImageUnscaled(bg, 0, 0);
            Door(g, 0);
            Car(g);
            Bike(g);
        }
        public void Event(Graphics g, double t)
        {
            g.DrawImageUnscaled(bg, 0, 0);
            double open = Math.Min(Seg(t, 0.6, 1.6), 1 - Seg(t, 11.8, 12.8));
            Door(g, open);
            double x = 0, feet = 0, h; int facing = 1; bool show = true;
            if (t < 1.4) show = false;
            else if (t < 6) { double q = Seg(t, 1.4, 6); x = Lerp(130, 360, q); feet = Lerp(320, 372, q); facing = 1; }
            else if (t < 8.2) { x = 360; feet = 372; facing = 2; }
            else if (t < 11.8) { double q = Seg(t, 8.2, 11.6); x = Lerp(360, 130, q); feet = Lerp(372, 320, q); facing = -1; }
            else show = false;
            h = 230 + (feet - 320) * 1.3;
            if (show) Person(g, x, feet, h, (t >= 6 && t < 8.2) ? 0 : t * 7, facing, look, false, 1.0);
            Car(g);
            Bike(g);
        }
    }

    // Living room (indoor camera). Event: Sam walks through the room.
    public class LivingRoom
    {
        public const int W = 854, H = 480;
        Bitmap bg;
        Look sam = new Look(Rgb(222, 180, 150), Rgb(120, 70, 40), Rgb(178, 52, 58), Rgb(54, 70, 104), Rgb(236, 236, 236));
        public LivingRoom()
        {
            bg = new Bitmap(W, H);
            var r = new Random(51);
            using (var g = Graphics.FromImage(bg))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                Gradient(g, new RectangleF(0, 0, W, 340), Rgb(228, 216, 196), Rgb(206, 192, 170));
                Gradient(g, new RectangleF(0, 340, W, 140), Rgb(160, 118, 80), Rgb(132, 94, 62));
                for (int i = 0; i < 9; i++) Line(g, Rgb(124, 88, 58), 1.2, 0, 344 + i * i * 1.8, W, 344 + i * i * 1.8);
                for (int i = 0; i < 30; i++) Line(g, A(120, Rgb(124, 88, 58)), 1, r.Next(W), 344 + r.Next(130), r.Next(W), 344 + r.Next(130));
                Rect(g, Rgb(240, 236, 228), 0, 334, W, 8);
                // rug
                Fill(g, Rgb(150, 160, 170), P(250, 380), P(700, 380), P(780, 470), P(170, 470));
                Fill(g, Rgb(170, 180, 186), P(270, 388), P(684, 388), P(752, 462), P(196, 462));
                // pictures
                RoundRect(g, Rgb(60, 50, 44), 520, 90, 80, 60, 2);
                Gradient(g, new RectangleF(526, 96, 68, 48), Rgb(120, 170, 200), Rgb(90, 140, 90));
                RoundRect(g, Rgb(60, 50, 44), 620, 80, 110, 76, 2);
                Gradient(g, new RectangleF(626, 86, 98, 64), Rgb(230, 190, 120), Rgb(190, 100, 80));
                // sofa
                RoundRect(g, Rgb(92, 108, 130), 480, 200, 330, 110, 20);
                RoundRect(g, Rgb(104, 120, 142), 470, 260, 350, 90, 18);
                RoundRect(g, Rgb(116, 132, 154), 500, 250, 140, 44, 12);
                RoundRect(g, Rgb(116, 132, 154), 650, 250, 140, 44, 12);
                RoundRect(g, Rgb(220, 170, 90), 520, 222, 50, 40, 10);
                Rect(g, Rgb(60, 50, 44), 486, 346, 10, 16);
                Rect(g, Rgb(60, 50, 44), 796, 346, 10, 16);
                // coffee table
                RoundRect(g, Rgb(110, 76, 50), 330, 360, 220, 22, 6);
                Rect(g, Rgb(90, 62, 40), 344, 380, 10, 34);
                Rect(g, Rgb(90, 62, 40), 526, 380, 10, 34);
                Ellipse(g, Rgb(240, 240, 236), 400, 356, 16, 6);
                RoundRect(g, Rgb(70, 110, 160), 450, 346, 50, 10, 2);
                // lamp
                Rect(g, Rgb(60, 56, 52), 64, 150, 6, 260);
                Ellipse(g, Rgb(60, 56, 52), 67, 410, 28, 6);
                Fill(g, Rgb(244, 230, 196), P(36, 150), P(98, 150), P(84, 100), P(50, 100));
                // plant
                Fill(g, Rgb(200, 196, 186), P(400, 300), P(450, 300), P(442, 344), P(408, 344));
                for (int i = 0; i < 9; i++) Line(g, Rgb(60, 120, 64), 6, 425, 300, 425 + Math.Cos(i * 0.7 + 3.4) * 50, 300 + Math.Sin(i * 0.7 + 3.4) * 60);
            }
        }
        void Window(Graphics g, double t)
        {
            Gradient(g, new RectangleF(140, 60, 240, 200), Rgb(160, 200, 236), Rgb(220, 232, 240));
            var r = new Random(2);
            Tree(g, r, 300, 300, 260, Rgb(84, 136, 66), t, 15);
            Rect(g, Rgb(120, 170, 90), 140, 230, 240, 30);
            using (var pen = new Pen(Rgb(246, 244, 240), 8)) g.DrawRectangle(pen, 140, 60, 240, 200);
            Line(g, Rgb(246, 244, 240), 6, 260, 60, 260, 260);
            Rect(g, Rgb(236, 232, 224), 130, 258, 260, 10);
            // curtains
            Fill(g, Rgb(196, 160, 120), P(110, 50), P(150, 50), P(146, 300), P(100, 300));
            Fill(g, Rgb(196, 160, 120), P(370, 50), P(410, 50), P(420, 300), P(374, 300));
            // sunlight patch on the floor
            Fill(g, A(40, Color.White), P(150, 350), P(380, 350), P(440, 470), P(120, 470));
        }
        public void Live(Graphics g, double t)
        {
            g.DrawImageUnscaled(bg, 0, 0);
            Window(g, t);
        }
        public void Event(Graphics g, double t)
        {
            g.DrawImageUnscaled(bg, 0, 0);
            Window(g, t);
            if (t < 0.8) return;
            double x, feet = 452; int facing = -1; double phase = t * 7;
            if (t < 5.4) x = Lerp(920, 320, Seg(t, 0.8, 5.4));
            else if (t < 7.2) { x = 320; facing = 2; phase = 0; }
            else x = Lerp(320, -90, Seg(t, 7.2, 10.4));
            Person(g, x, feet, 330, phase, facing, sam, false, 1.0);
        }
    }
}
