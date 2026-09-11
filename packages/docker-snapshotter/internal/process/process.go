package process

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

func Must(err error) {
	if err != nil {
		panic(err)
	}
}
func Listen(path string) net.Listener {
	if e := os.Remove(path); e != nil && !os.IsNotExist(e) {
		Must(e)
	}
	l, e := net.Listen("unix", path)
	Must(e)
	Must(os.Chmod(path, 0600))
	return l
}
func LockStore(root string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(root, "owner.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("snapshotter store already owned: %w", err)
	}
	return f, nil
}
