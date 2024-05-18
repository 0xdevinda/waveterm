// Copyright 2024, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockstore

import (
	"bytes"
	"context"
	"log"
	"testing"
	"time"

	"github.com/google/uuid"
)

func initDb(t *testing.T) {
	t.Logf("initializing db for %q", t.Name())
	useTestingDb = true
	partDataSize = 50
	stopFlush.Store(true)
	err := InitBlockstore()
	if err != nil {
		t.Fatalf("error initializing blockstore: %v", err)
	}
}

func cleanupDb(t *testing.T) {
	t.Logf("cleaning up db for %q", t.Name())
	if globalDB != nil {
		globalDB.Close()
		globalDB = nil
	}
	useTestingDb = false
	partDataSize = DefaultPartDataSize
	GBS.clearCache()
}

func TestCreate(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)

	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	blockId := uuid.New().String()
	err := GBS.MakeFile(ctx, blockId, "testfile", nil, FileOptsType{})
	if err != nil {
		t.Fatalf("error creating file: %v", err)
	}
	file, err := GBS.Stat(ctx, blockId, "testfile")
	if err != nil {
		t.Fatalf("error stating file: %v", err)
	}
	if file == nil {
		t.Fatalf("file not found")
	}
	if file.BlockId != blockId {
		t.Fatalf("block id mismatch")
	}
	if file.Name != "testfile" {
		t.Fatalf("name mismatch")
	}
	if file.Size != 0 {
		t.Fatalf("size mismatch")
	}
	if file.CreatedTs == 0 {
		t.Fatalf("created ts zero")
	}
	if file.ModTs == 0 {
		t.Fatalf("mod ts zero")
	}
	if file.CreatedTs != file.ModTs {
		t.Fatalf("create ts != mod ts")
	}
	if len(file.Meta) != 0 {
		t.Fatalf("meta should have no values")
	}
	if file.Opts.Circular || file.Opts.IJson || file.Opts.MaxSize != 0 {
		t.Fatalf("opts not empty")
	}
	err = GBS.DeleteFile(ctx, blockId, "testfile")
	if err != nil {
		t.Fatalf("error deleting file: %v", err)
	}
}

func containsFile(arr []*BlockFile, name string) bool {
	for _, f := range arr {
		if f.Name == name {
			return true
		}
	}
	return false
}

func TestDelete(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)

	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	blockId := uuid.New().String()
	err := GBS.MakeFile(ctx, blockId, "testfile", nil, FileOptsType{})
	if err != nil {
		t.Fatalf("error creating file: %v", err)
	}
	err = GBS.DeleteFile(ctx, blockId, "testfile")
	if err != nil {
		t.Fatalf("error deleting file: %v", err)
	}
	file, err := GBS.Stat(ctx, blockId, "testfile")
	if err != nil {
		t.Fatalf("error stating file: %v", err)
	}
	if file != nil {
		t.Fatalf("file should not be found")
	}

	// create two files in same block, use DeleteBlock to delete
	err = GBS.MakeFile(ctx, blockId, "testfile1", nil, FileOptsType{})
	if err != nil {
		t.Fatalf("error creating file: %v", err)
	}
	err = GBS.MakeFile(ctx, blockId, "testfile2", nil, FileOptsType{})
	if err != nil {
		t.Fatalf("error creating file: %v", err)
	}
	files, err := GBS.ListFiles(ctx, blockId)
	if err != nil {
		t.Fatalf("error listing files: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("file count mismatch")
	}
	if !containsFile(files, "testfile1") || !containsFile(files, "testfile2") {
		t.Fatalf("file names mismatch")
	}
	err = GBS.DeleteBlock(ctx, blockId)
	if err != nil {
		t.Fatalf("error deleting block: %v", err)
	}
	files, err = GBS.ListFiles(ctx, blockId)
	if err != nil {
		t.Fatalf("error listing files: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("file count mismatch")
	}
}

func checkMapsEqual(t *testing.T, m1 map[string]any, m2 map[string]any, msg string) {
	if len(m1) != len(m2) {
		t.Errorf("%s: map length mismatch", msg)
	}
	for k, v := range m1 {
		if m2[k] != v {
			t.Errorf("%s: value mismatch for key %q", msg, k)
		}
	}
}

func TestSetMeta(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)

	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	blockId := uuid.New().String()
	err := GBS.MakeFile(ctx, blockId, "testfile", nil, FileOptsType{})
	if err != nil {
		t.Fatalf("error creating file: %v", err)
	}
	if GBS.getCacheSize() != 0 {
		t.Errorf("cache size mismatch -- should have 0 entries after create")
	}
	err = GBS.WriteMeta(ctx, blockId, "testfile", map[string]any{"a": 5, "b": "hello", "q": 8}, false)
	if err != nil {
		t.Fatalf("error setting meta: %v", err)
	}
	file, err := GBS.Stat(ctx, blockId, "testfile")
	if err != nil {
		t.Fatalf("error stating file: %v", err)
	}
	if file == nil {
		t.Fatalf("file not found")
	}
	checkMapsEqual(t, map[string]any{"a": 5, "b": "hello", "q": 8}, file.Meta, "meta")
	if GBS.getCacheSize() != 1 {
		t.Errorf("cache size mismatch")
	}
	err = GBS.WriteMeta(ctx, blockId, "testfile", map[string]any{"a": 6, "c": "world", "d": 7, "q": nil}, true)
	if err != nil {
		t.Fatalf("error setting meta: %v", err)
	}
	file, err = GBS.Stat(ctx, blockId, "testfile")
	if err != nil {
		t.Fatalf("error stating file: %v", err)
	}
	if file == nil {
		t.Fatalf("file not found")
	}
	checkMapsEqual(t, map[string]any{"a": 6, "b": "hello", "c": "world", "d": 7}, file.Meta, "meta")

	err = GBS.WriteMeta(ctx, blockId, "testfile-notexist", map[string]any{"a": 6}, true)
	if err == nil {
		t.Fatalf("expected error setting meta")
	}
	err = nil
}

func checkFileSize(t *testing.T, ctx context.Context, blockId string, name string, size int64) {
	file, err := GBS.Stat(ctx, blockId, name)
	if err != nil {
		t.Errorf("error stating file %q: %v", name, err)
		return
	}
	if file == nil {
		t.Errorf("file %q not found", name)
		return
	}
	if file.Size != size {
		t.Errorf("size mismatch for file %q: expected %d, got %d", name, size, file.Size)
	}
}

func checkFileData(t *testing.T, ctx context.Context, blockId string, name string, data string) {
	_, rdata, err := GBS.ReadFile(ctx, blockId, name)
	if err != nil {
		t.Errorf("error reading data for file %q: %v", name, err)
		return
	}
	if string(rdata) != data {
		t.Errorf("data mismatch for file %q: expected %q, got %q", name, data, string(rdata))
	}
}

func checkFileDataAt(t *testing.T, ctx context.Context, blockId string, name string, offset int64, data string) {
	_, rdata, err := GBS.ReadAt(ctx, blockId, name, offset, int64(len(data)))
	if err != nil {
		t.Errorf("error reading data for file %q: %v", name, err)
		return
	}
	if string(rdata) != data {
		t.Errorf("data mismatch for file %q: expected %q, got %q", name, data, string(rdata))
	}
}

func TestAppend(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)

	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	blockId := uuid.New().String()
	fileName := "t2"
	err := GBS.MakeFile(ctx, blockId, fileName, nil, FileOptsType{})
	if err != nil {
		t.Fatalf("error creating file: %v", err)
	}
	err = GBS.AppendData(ctx, blockId, fileName, []byte("hello"))
	if err != nil {
		t.Fatalf("error appending data: %v", err)
	}
	// fmt.Print(GBS.dump())
	checkFileSize(t, ctx, blockId, fileName, 5)
	checkFileData(t, ctx, blockId, fileName, "hello")
	err = GBS.AppendData(ctx, blockId, fileName, []byte(" world"))
	if err != nil {
		t.Fatalf("error appending data: %v", err)
	}
	// fmt.Print(GBS.dump())
	checkFileSize(t, ctx, blockId, fileName, 11)
	checkFileData(t, ctx, blockId, fileName, "hello world")
}

func makeText(n int) string {
	var buf bytes.Buffer
	for i := 0; i < n; i++ {
		buf.WriteByte(byte('0' + (i % 10)))
	}
	return buf.String()
}

func TestMultiPart(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)

	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	blockId := uuid.New().String()
	fileName := "m2"
	data := makeText(80)
	err := GBS.MakeFile(ctx, blockId, fileName, nil, FileOptsType{})
	if err != nil {
		t.Fatalf("error creating file: %v", err)
	}
	err = GBS.AppendData(ctx, blockId, fileName, []byte(data))
	if err != nil {
		t.Fatalf("error appending data: %v", err)
	}
	checkFileSize(t, ctx, blockId, fileName, 80)
	checkFileData(t, ctx, blockId, fileName, data)
	_, barr, err := GBS.ReadAt(ctx, blockId, fileName, 42, 10)
	if err != nil {
		t.Fatalf("error reading data: %v", err)
	}
	if string(barr) != data[42:52] {
		t.Errorf("data mismatch: expected %q, got %q", data[42:52], string(barr))
	}
	GBS.WriteAt(ctx, blockId, fileName, 49, []byte("world"))
	checkFileSize(t, ctx, blockId, fileName, 80)
	checkFileDataAt(t, ctx, blockId, fileName, 49, "world")
	checkFileDataAt(t, ctx, blockId, fileName, 48, "8world4")
}

func testIntMapsEq(t *testing.T, msg string, m map[int]int, expected map[int]int) {
	if len(m) != len(expected) {
		t.Errorf("%s: map length mismatch got:%d expected:%d", msg, len(m), len(expected))
		return
	}
	for k, v := range m {
		if expected[k] != v {
			t.Errorf("%s: value mismatch for key %d, got:%d expected:%d", msg, k, v, expected[k])
		}
	}
}

func TestComputePartMap(t *testing.T) {
	partDataSize = 100
	defer func() {
		partDataSize = DefaultPartDataSize
	}()
	file := &BlockFile{}
	m := file.computePartMap(0, 250)
	testIntMapsEq(t, "map1", m, map[int]int{0: 100, 1: 100, 2: 50})
	m = file.computePartMap(110, 40)
	log.Printf("map2:%#v\n", m)
	testIntMapsEq(t, "map2", m, map[int]int{1: 40})
	m = file.computePartMap(110, 90)
	testIntMapsEq(t, "map3", m, map[int]int{1: 90})
	m = file.computePartMap(110, 91)
	testIntMapsEq(t, "map4", m, map[int]int{1: 90, 2: 1})
	m = file.computePartMap(820, 340)
	testIntMapsEq(t, "map5", m, map[int]int{8: 80, 9: 100, 10: 100, 11: 60})

	// now test circular
	file = &BlockFile{Opts: FileOptsType{Circular: true, MaxSize: 1000}}
	m = file.computePartMap(10, 250)
	testIntMapsEq(t, "map6", m, map[int]int{0: 90, 1: 100, 2: 60})
	m = file.computePartMap(990, 40)
	testIntMapsEq(t, "map7", m, map[int]int{9: 10, 0: 30})
	m = file.computePartMap(990, 130)
	testIntMapsEq(t, "map8", m, map[int]int{9: 10, 0: 100, 1: 20})
	m = file.computePartMap(5, 1105)
	testIntMapsEq(t, "map9", m, map[int]int{0: 100, 1: 10, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, 7: 100, 8: 100, 9: 100})
	m = file.computePartMap(2005, 1105)
	testIntMapsEq(t, "map9", m, map[int]int{0: 100, 1: 10, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, 7: 100, 8: 100, 9: 100})
}
