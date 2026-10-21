using System.TestLibraries.Security.AccessControl;

codeunit 50224 "BCD Coordinator Perm Tests"
{
    Subtype = Test;
    TestPermissions = Restrictive;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure CompletedInsertReplaysWithReadOnlyRights()
    var
        RunId: Guid;
        RequestId: Guid;
        Epoch: Guid;
        Input: Text;
        ResultText: Text;
    begin
        Initialize(RunId, RequestId, Epoch, Input);
        ResultText := Coordinator.Execute(RequestId, Epoch, Input);
        Commit();
        PermissionsMock.Set('BCD COORD REPLAY');
        Assert.AreEqual(ResultText, Coordinator.Execute(RequestId, Epoch, Input), 'Replay needs no receipt Modify or target Insert.');
        CheckSingleInsertAndClean(RunId, RequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure TargetReadRevocationBlocksStoredValues()
    var
        RunId: Guid;
        RequestId: Guid;
        Epoch: Guid;
        Input: Text;
        ResultText: Text;
    begin
        Initialize(RunId, RequestId, Epoch, Input);
        ResultText := Coordinator.Execute(RequestId, Epoch, Input);
        Commit();
        PermissionsMock.Set('BCD COORD NO TARGET');
        asserterror Coordinator.Execute(RequestId, Epoch, Input);
        Assert.ExpectedError('BCD Mutation Fixture');
        PermissionsMock.Set('BCD COORD REPLAY');
        Assert.AreEqual(ResultText, Coordinator.Execute(RequestId, Epoch, Input), 'Restored Read returns unchanged history.');
        CheckSingleInsertAndClean(RunId, RequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ReceiptReadRevocationBlocksHistory()
    var
        RunId: Guid;
        RequestId: Guid;
        Epoch: Guid;
        Input: Text;
        ResultText: Text;
    begin
        Initialize(RunId, RequestId, Epoch, Input);
        ResultText := Coordinator.Execute(RequestId, Epoch, Input);
        Commit();
        PermissionsMock.Set('BCD COORD NO RCPT R');
        asserterror Coordinator.Execute(RequestId, Epoch, Input);
        Assert.ExpectedError('BCD Mutation Receipt');
        PermissionsMock.Set('BCD COORD REPLAY');
        Assert.AreEqual(ResultText, Coordinator.Execute(RequestId, Epoch, Input), 'Revocation must not erase completed history.');
        CheckSingleInsertAndClean(RunId, RequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure MissingReceiptModifyBlocksBeforeBusinessTriggers()
    var
        RunId: Guid;
        RequestId: Guid;
        Epoch: Guid;
        Input: Text;
    begin
        Initialize(RunId, RequestId, Epoch, Input);
        PermissionsMock.Set('BCD COORD NO ANCHOR');
        asserterror Coordinator.Execute(RequestId, Epoch, Input);
        Assert.ExpectedError('BCD Mutation Receipt');
        CheckEmptyReservation(RunId, RequestId);
        Clean(RunId, RequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure DeniedBusinessInsertLeavesScopeReusableAfterKnownError()
    var
        RunId: Guid;
        RequestId: Guid;
        Epoch: Guid;
        Input: Text;
    begin
        Initialize(RunId, RequestId, Epoch, Input);
        PermissionsMock.Set('BCD COORD TARGET R');
        asserterror Coordinator.Execute(RequestId, Epoch, Input);
        Assert.ExpectedError('BCD Mutation Fixture');
        CheckEmptyReservation(RunId, RequestId);
        Coordinator.Execute(RequestId, Epoch, Input);
        CheckSingleInsertAndClean(RunId, RequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ReplacementCannotAuthorizeOriginalInsertHistory()
    var
        Row: Record "BCD Mutation Fixture";
        RunId: Guid;
        RequestId: Guid;
        Epoch: Guid;
        OriginalId: Guid;
        Input: Text;
    begin
        Initialize(RunId, RequestId, Epoch, Input);
        Coordinator.Execute(RequestId, Epoch, Input);
        Row.Get(RunId, 'A', 1);
        OriginalId := Row.SystemId;
        Row.Delete();
        Clear(Row);
        Row."Run ID" := RunId;
        Row.Name := 'A';
        Row.Sequence := 1;
        Row.Insert();
        Assert.AreNotEqual(OriginalId, Row.SystemId, 'Replacement must have another identity.');
        Commit();
        PermissionsMock.Set('BCD COORD REPLAY');
        asserterror Coordinator.Execute(RequestId, Epoch, Input);
        Assert.ExpectedError('BCD_REPLAY_TARGET_UNAVAILABLE');
        PermissionsMock.Set('BCD COORD SETUP');
        Row.Get(RunId, 'A', 1);
        Row.TestField("Insert Count", 0);
        Clean(RunId, RequestId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure DeleteAcknowledgementNeedsReceiptReadOnly()
    var
        Row: Record "BCD Mutation Fixture";
        Receipt: Record "BCD Mutation Receipt";
        RunId: Guid;
        InsertId: Guid;
        InsertEpoch: Guid;
        DeleteId: Guid;
        DeleteEpoch: Guid;
        Input: Text;
        DeleteInput: Text;
        ResultText: Text;
    begin
        Initialize(RunId, InsertId, InsertEpoch, Input);
        Coordinator.Execute(InsertId, InsertEpoch, Input);
        Row.Get(RunId, 'A', 1);
        DeleteId := CreateGuid();
        DeleteEpoch := EpochFrom(Coordinator.Prepare(DeleteId));
        DeleteInput := '{"operation":"delete","tableId":50221,"systemId":"' + Format(Row.SystemId, 0, 4) +
            '","expectedVersion":"' + Format(Row.SystemRowVersion, 0, 9) + '"}';
        ResultText := Coordinator.Execute(DeleteId, DeleteEpoch, DeleteInput);
        Commit();
        PermissionsMock.Set('BCD COORD NO TARGET');
        Assert.AreEqual(ResultText, Coordinator.Execute(DeleteId, DeleteEpoch, DeleteInput), 'Minimal delete acknowledgement needs no absent-row rights.');
        PermissionsMock.Set('BCD COORD NO RCPT R');
        asserterror Coordinator.Execute(DeleteId, DeleteEpoch, DeleteInput);
        Assert.ExpectedError('BCD Mutation Receipt');
        PermissionsMock.Set('BCD COORD SETUP');
        Assert.IsFalse(Row.Get(RunId, 'A', 1), 'Replay cannot resurrect the target.');
        Receipt.Get(UserSecurityId(), InsertId);
        Receipt.Delete();
        Clean(RunId, DeleteId);
    end;

    local procedure Initialize(var RunId: Guid; var RequestId: Guid; var Epoch: Guid; var Input: Text)
    begin
        if PermissionsMock.IsStarted() then
            PermissionsMock.Stop();
        PermissionsMock.Start();
        PermissionsMock.Set('BCD COORD SETUP');
        RunId := CreateGuid();
        RequestId := CreateGuid();
        Epoch := EpochFrom(Coordinator.Prepare(RequestId));
        Input := '{"operation":"insert","tableId":50221,"fields":[{"fieldId":1,"value":"' +
            Format(RunId, 0, 4) + '"},{"fieldId":2,"value":"A"},{"fieldId":3,"value":1}]}';
        Commit();
    end;

    local procedure EpochFrom(Prepared: Text): Guid
    var
        Response: JsonObject;
        Token: JsonToken;
        Epoch: Guid;
    begin
        Response.ReadFrom(Prepared);
        Response.Get('epoch', Token);
        Evaluate(Epoch, Token.AsValue().AsText());
        exit(Epoch);
    end;

    local procedure CheckEmptyReservation(RunId: Guid; RequestId: Guid)
    var
        Row: Record "BCD Mutation Fixture";
        Receipt: Record "BCD Mutation Receipt";
        Entry: Record "BCD Mutation Trigger Log";
    begin
        PermissionsMock.Set('BCD COORD SETUP');
        Row.SetRange("Run ID", RunId);
        Entry.SetRange("Run ID", RunId);
        Assert.IsTrue(Row.IsEmpty() and Entry.IsEmpty(), 'Permission denial rolls back target and trigger effects.');
        Receipt.Get(UserSecurityId(), RequestId);
        Receipt.TestField(Completed, false);
        Receipt.TestField("Owner Session ID", 0);
        Receipt.CalcFields(Payload, Result);
        Assert.IsFalse(Receipt.Payload.HasValue() or Receipt.Result.HasValue(), 'No payload/result survives a denied command.');
    end;

    local procedure CheckSingleInsertAndClean(RunId: Guid; RequestId: Guid)
    var
        Row: Record "BCD Mutation Fixture";
        Entry: Record "BCD Mutation Trigger Log";
    begin
        PermissionsMock.Set('BCD COORD SETUP');
        Row.Get(RunId, 'A', 1);
        Row.TestField("Insert Count", 1);
        Entry.SetRange("Run ID", RunId);
        Assert.AreEqual(1, Entry.Count(), 'Replay cannot execute the insert trigger again.');
        Clean(RunId, RequestId);
    end;

    local procedure Clean(RunId: Guid; RequestId: Guid)
    var
        Row: Record "BCD Mutation Fixture";
        Entry: Record "BCD Mutation Trigger Log";
        Receipt: Record "BCD Mutation Receipt";
    begin
        PermissionsMock.Set('BCD COORD SETUP');
        Row.SetRange("Run ID", RunId);
        Row.DeleteAll();
        Entry.SetRange("Run ID", RunId);
        Entry.DeleteAll();
        Receipt.Get(UserSecurityId(), RequestId);
        Receipt.Delete();
        PermissionsMock.Stop();
    end;

    var
        PermissionsMock: Codeunit "Permissions Mock";
        Coordinator: Codeunit "BCD Mutation Coordinator";
        Assert: Codeunit "Library Assert";
}
