package main

import (
	"context"
	"kissopen.local/accounts/internal/app"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() error {
	c, err := app.LoadConfig()
	if err != nil {
		return err
	}
	a, err := app.New(c)
	if err != nil {
		return err
	}
	defer a.Store.DB.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	s := &http.Server{Addr: c.Addr, Handler: a, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.Shutdown(shutdown)
	}()
	log.Printf("KissOpen accounts listening on %s (%s); local-Agent-only edition", c.Addr, c.Mode)
	err = s.ListenAndServe()
	stop()
	<-done
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
