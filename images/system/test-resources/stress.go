package main

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"sync"
	"time"
)

func main() {
	mode := os.Args[1]
	switch mode {
	case "probe":
		fmt.Println("build RUN probe")
		time.Sleep(10 * time.Second)
	case "cpu":
		for {
		}
	case "memory":
		n, _ := strconv.Atoi(os.Args[2])
		chunks := [][]byte{}
		for i := 0; i < n; i++ {
			b := make([]byte, 1024*1024)
			for j := 0; j < len(b); j += 4096 {
				b[j] = 1
			}
			chunks = append(chunks, b)
			time.Sleep(time.Millisecond)
		}
		fmt.Println("allocated", len(chunks))
		time.Sleep(60 * time.Second)
		runtime.KeepAlive(chunks)
	case "pids":
		var ready sync.WaitGroup
		n := 4000
		if len(os.Args) > 2 {
			n, _ = strconv.Atoi(os.Args[2])
		}
		for i := 0; i < n; i++ {
			ready.Add(1)
			go func() { runtime.LockOSThread(); ready.Done(); time.Sleep(60 * time.Second) }()
			ready.Wait()
		}
		time.Sleep(60 * time.Second)
	case "io":
		f, e := os.OpenFile("/data/stress-file", os.O_CREATE|os.O_RDWR|os.O_SYNC, 0600)
		if e != nil {
			panic(e)
		}
		defer f.Close()
		b := make([]byte, 1024*1024)
		for i := range b {
			b[i] = byte(i)
		}
		for {
			for i := 0; i < 128; i++ {
				if _, e = f.WriteAt(b, int64(i*len(b))); e != nil {
					panic(e)
				}
			}
		}
	}
}
