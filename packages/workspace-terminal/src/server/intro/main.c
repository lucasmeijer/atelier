#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
/* Terminal-native rendering of Atelier's logo easter egg. Braille provides a
   2x4 dot grid per cell without imposing a background color. Source geometry:
   apps/web/src/server/atelier-easter-egg.ts; timing: public/style.css. */
#define DURATION 4.3
#define PLAYBACK_SPEED 4.0
#define ACCENT 0xdba03bU
static const char caption[] = "m a d e   f o r   h u m a n s";
typedef struct { unsigned char dots, accent; } Cell;
typedef struct {
    int cols, rows, left, top, width, height, caption_row;
    double scale;
    Cell *previous;
    bool caption_drawn;
} Canvas;
static volatile sig_atomic_t stopped;
static struct termios saved;
static bool terminal_active, input_changed;
static int prompt_row = 1;

static void on_signal(int sig) { stopped = sig; }
static void cleanup(void) {
    if (terminal_active) {
        /* Stay on the normal screen: retain the tagline and give the shell a
           clean, default-colored bottom row. Never print a fake prompt. */
        printf("\033[0m\033[%d;1H\033[2K\033[?25h", prompt_row);
        fflush(stdout);
        terminal_active = false;
    }
    if (input_changed) {
        /* Do not read or flush the keystroke that skipped the intro. */
        if (tcsetattr(STDIN_FILENO, TCSANOW, &saved) < 0) perror("tcsetattr restore");
        input_changed = false;
    }
}
static double now(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t) < 0) { perror("clock_gettime"); exit(1); }
    return t.tv_sec + t.tv_nsec / 1e9;
}
static void *allocate(size_t n, size_t size) {
    void *p = calloc(n, size);
    if (!p) { perror("calloc"); exit(1); }
    return p;
}
static double clamp(double x) { return fmax(0, fmin(1, x)); }
static double ease(double x) { x=clamp(x); return x*x*(3-2*x); }
static void rgb(uint32_t color, bool background) {
    printf("\033[%d;2;%u;%u;%um", background?48:38,
           (color>>16)&255, (color>>8)&255, color&255);
}
static void clear_canvas(Canvas *c) {
    fputs("\033[0m\033[49m\033[2J\033[H",stdout);
    memset(c->previous,0,(size_t)c->cols*c->rows*sizeof(Cell));
    c->caption_drawn=false;
}
static int update_size(Canvas *c) {
    struct winsize ws;
    if (ioctl(STDOUT_FILENO,TIOCGWINSZ,&ws)<0) { perror("TIOCGWINSZ"); return -1; }
    if (!ws.ws_col || !ws.ws_row) return 0;
    if (ws.ws_col!=c->cols || ws.ws_row!=c->rows) {
        free(c->previous);
        c->cols=ws.ws_col; c->rows=ws.ws_row;
        c->previous=allocate((size_t)c->cols*c->rows,sizeof(Cell));
        clear_canvas(c);
    }
    /* Current PTY geometry, before every frame; time never resets on resize. */
    prompt_row=c->rows;
    c->scale=fmax(.05,fmin(2.4,fmin((c->cols-6)*2.0/48,(c->rows-7)*4.0/40)));
    c->width=(int)ceil(48*c->scale/2);
    c->height=(int)ceil(40*c->scale/4);
    c->left=(c->cols-c->width)/2;
    c->top=(int)fmax(0,(c->rows-c->height-4)/2);
    c->caption_row=c->top+c->height+2;
    return 1;
}
static double segment(double x,double y,double ax,double ay,double bx,double by) {
    double dx=bx-ax,dy=by-ay;
    double t=clamp(((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy));
    return hypot(x-ax-t*dx,y-ay-t*dy);
}
static bool mark(double x,double y) {
    static const double lines[][4]={{12,3,12,7},{7.5,21,12,7},{12,7,16.5,21},{6,18,18,18}};
    for (int i=0;i<4;i++)
        if (segment(x,y,lines[i][0],lines[i][1],lines[i][2],lines[i][3])<.85) return true;
    static const double curves[][8]={{4,13,8,14.5,11.5,14.8,15,13.8},{15,13.8,17,13.2,18.7,13.2,20,13.6}};
    for (int c=0;c<2;c++) {
        const double *p=curves[c]; double px=p[0],py=p[1];
        for (int i=1;i<=20;i++) {
            double t=i/20.0,u=1-t;
            double qx=u*u*u*p[0]+3*u*u*t*p[2]+3*u*t*t*p[4]+t*t*t*p[6];
            double qy=u*u*u*p[1]+3*u*u*t*p[3]+3*u*t*t*p[5]+t*t*t*p[7];
            if (segment(x,y,px,py,qx,qy)<.85) return true;
            px=qx;py=qy;
        }
    }
    return false;
}
static bool ellipse(double x,double y,double cx,double cy,double rx,double ry) {
    return pow((x-cx)/rx,2)+pow((y-cy)/ry,2)<=1;
}
typedef struct { double shift,sx,sy,look,scream,portal; bool eyes,panic,visible; } Pose;
static Pose pose(double t) {
    /* The first 59.2% of the original seven-second journey. No ceiling portal,
       hidden reset, return fall, or bounce-back is included. */
    double lift=ease((t-1.96)/.448),fall=ease((t-2.856)/.616);
    return (Pose){
        .shift=-3*lift+63*fall,.sx=1-.1*lift-.2*fall,.sy=1+.1*lift+.25*fall,
        .look=2*ease((t-.8)/.768)*(1-ease((t-2.016)/.28)),
        .scream=.7+.6*ease((t-2.184)/.532),
        .portal=ease((t-1.008)/.392)*(1-ease((t-3.696)/.448)),
        .eyes=t>=.392 && t<3.276,.panic=t>=2.184 && t<3.388,.visible=t<3.472
    };
}
static int dot(double x,double y,Pose p) {
    int color=0;
    if (p.portal>.01 && ellipse(x,y,12,31,17*p.portal,3) &&
        !ellipse(x,y,12,31,fmax(.01,17*p.portal-.8),2.2)) color=2;
    /* Clip at the floor: the actor disappears INTO the portal. */
    if (!p.visible || y>31 || y< -16) return color;
    x=(x-12)/p.sx+12; y=(y-12-p.shift)/p.sy+12;
    bool ink=mark(x,y);
    if (p.panic) {
        static const double arms[][4]={{5,14,-2,6},{-2,6,-6,3},{19,14,26,6},{26,6,30,3}};
        for (int i=0;i<4;i++) if (segment(x,y,arms[i][0],arms[i][1],arms[i][2],arms[i][3])<.85) ink=true;
    }
    if (p.eyes) for (int eye=0;eye<2;eye++) {
        double cx=eye?16:9;
        if (ellipse(x,y,cx,10,3.2,4))
            ink=!ellipse(x,y,cx,10,2.4,3.2) || ellipse(x,y,cx,10+p.look,1.2,1.2);
    }
    if (p.panic && ellipse(x,y,12,18,2.7*p.scream,4*p.scream))
        ink=!ellipse(x,y,12,18,2.7*p.scream-.8,4*p.scream-.8);
    return ink?1:color;
}
static void braille(unsigned char dots) {
    unsigned code=0x2800+dots;
    fputc(0xe0|(code>>12),stdout);
    fputc(0x80|((code>>6)&63),stdout);
    fputc(0x80|(code&63),stdout);
}
static int render(Canvas *c,double time,bool clear) {
    int sized=update_size(c);
    if (sized<=0) return sized;
    if (clear) clear_canvas(c);
    Pose p=pose(time);
    static const int bits[4][2]={{0,3},{1,4},{2,5},{6,7}};
    for (int row=0;row<c->rows-1;row++) for (int col=0;col<c->cols-1;col++) {
        Cell next={0,0}; int ink_count=0,accent_count=0;
        if (col>=c->left && col<c->left+c->width && row>=c->top && row<c->top+c->height) {
            for (int dy=0;dy<4;dy++) for (int dx=0;dx<2;dx++) {
                double x=((col-c->left)*2+dx+.5)/c->scale-12;
                double y=((row-c->top)*4+dy+.5)/c->scale-4;
                int color=dot(x,y,p);
                if (color) next.dots|=(unsigned char)(1<<bits[dy][dx]);
                ink_count+=color==1; accent_count+=color==2;
            }
        }
        next.accent=accent_count>ink_count;
        Cell *old=&c->previous[(size_t)row*c->cols+col];
        if (next.dots==old->dots && next.accent==old->accent) continue;
        printf("\033[%d;%dH\033[49m",row+1,col+1);
        if (next.accent) rgb(ACCENT,false); else fputs("\033[39m",stdout);
        if (next.dots) braille(next.dots); else fputc(' ',stdout);
        *old=next;
    }
    if (!c->caption_drawn && c->cols>(int)strlen(caption)+4 && c->caption_row<c->rows-1) {
        fputs("\033[49m",stdout);rgb(0x99a493,false);
        printf("\033[%d;%dH%s",c->caption_row,(c->cols-(int)strlen(caption))/2+1,caption);
        c->caption_drawn=true;
    }
    if (fflush(stdout)==EOF) stopped=SIGPIPE;
    return 1;
}
int main(int argc, char **argv) {
    if (argc!=1) {
        bool help=argc==2 && strcmp(argv[1],"--help")==0;
        fprintf(help?stdout:stderr,"Usage: %s\nAtelier logo easter egg: look, panic, fall through a portal.\nRuns once (1.075 seconds). The logo never returns. Any input skips to the end.\n",argv[0]);
        return help?0:2;
    }
    if (!isatty(STDOUT_FILENO)) return 0;
    const char *term=getenv("TERM");
    if (term && strcmp(term,"dumb")==0) return 0;
    static char output[256*1024];
    setvbuf(stdout,output,_IOFBF,sizeof output);
    atexit(cleanup);
    struct sigaction action={0};
    action.sa_handler=on_signal; sigemptyset(&action.sa_mask);
    const int signals[]={SIGINT,SIGTERM,SIGHUP,SIGPIPE};
    for (size_t i=0; i<sizeof signals/sizeof *signals; i++)
        if (sigaction(signals[i],&action,NULL)<0) { perror("sigaction"); return 1; }
    bool input_tty=isatty(STDIN_FILENO);
    if (input_tty) {
        if (tcgetattr(STDIN_FILENO,&saved)<0) { perror("tcgetattr"); return 1; }
        struct termios mode=saved; mode.c_lflag &= (tcflag_t)~(ICANON|ECHO);
        if (tcsetattr(STDIN_FILENO,TCSANOW,&mode)<0) { perror("tcsetattr"); return 1; }
        input_changed=true;
    }
    terminal_active=true;
    fputs("\033[0m\033[?25l",stdout);
    Canvas canvas={0};
    double start=now(), deadline=start;
    int result=0;
    while (!stopped) {
        double elapsed=(now()-start)*PLAYBACK_SPEED;
        if (elapsed>=DURATION) break;
        if (render(&canvas,elapsed,false)<0) { result=1; break; }
        deadline+=1.0/60;
        int delay=(int)ceil(fmax(0,deadline-now())*1000);
        struct pollfd input={STDIN_FILENO,POLLIN,0};
        int ready=poll(input_tty?&input:NULL,input_tty?1:0,delay);
        if (ready>0) break;
        if (ready<0 && errno!=EINTR) { perror("poll"); result=1; break; }
        if (now()-deadline>.1) deadline=now();
    }
    /* Skip to the empty end state, never redraw or resurrect the actor. */
    if (!result && stopped!=SIGPIPE && stopped!=SIGHUP) {
        if (render(&canvas,DURATION,true)<0) result=1;
    }
    free(canvas.previous);
    cleanup();
    return stopped ? 128+stopped : result;
}
