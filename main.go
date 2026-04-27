package main

import (
	"context"
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

func main() {
	addr := ":1010"
	if v := os.Getenv("PORT"); v != "" {
		addr = ":" + v
	}

	arena := NewArenaHub()
	go arena.Run()

	mux := http.NewServeMux()

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("embed sub: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(sub)))

	mux.HandleFunc("/ws/arena", arena.ServeWS)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("superhry listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
